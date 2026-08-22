"""验证技能库服务（Spec 03 §8：AI 自主技能扩展）。

- 技能 = 命名 + 参数签名 + 步骤模板（仅 9 基础动作组合，支持 ``{param}`` 占位）；
- 提议（proposed_skills）首次仅内联展开落库，不进技能库——零治理成本；
- 验证通过后由学习阶段蒸馏 upsert 入库（去重合并、版本递增、记录来源与统计）；
- 复用：planning 模板渲染 ``{skill_library}`` 动态段，LLM 按技能生成展开步骤；
- 安全：模板与展开产物仍是 9 动作，词表校验/只读 SELECT/双保险全部照常生效。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from autobugfixer.common.core.models import VerificationSkill


class SkillService:
    """技能库服务：入库沉淀（upsert）、技能清单渲染、复用结构匹配与统计。"""

    def __init__(self, session: Session) -> None:
        self.session = session

    def list_active(self) -> list[VerificationSkill]:
        """当前可用技能清单（渲染 {skill_library} 动态段用）。"""
        return list(self.session.scalars(select(VerificationSkill).where(
            VerificationSkill.status == "active").order_by(VerificationSkill.id)).all())

    def upsert(self, *, name: str, params: list[str], desc: str,
               template_steps: list[dict], source_task_id: int) -> tuple[VerificationSkill, bool]:
        """蒸馏入库（去重合并）：同名且模板有实质变化 -> 覆盖 + version+1；
        模板相同 -> 仅追加来源任务；返回 (技能, 是否新建)。
        """
        existing = self.session.scalar(select(VerificationSkill).where(
            VerificationSkill.name == name))
        signature = ", ".join(params)
        if existing is None:
            skill = VerificationSkill(
                name=name, params_signature=signature, desc=desc,
                template_steps=template_steps, source_task_ids=[source_task_id])
            self.session.add(skill)
            self.session.flush()
            return skill, True
        if existing.template_steps != template_steps or existing.params_signature != signature:
            existing.template_steps = template_steps
            existing.params_signature = signature
            existing.desc = desc or existing.desc
            existing.version += 1  # 模板演化留版本痕迹
        if source_task_id not in (existing.source_task_ids or []):
            existing.source_task_ids = (existing.source_task_ids or []) + [source_task_id]
        self.session.flush()
        return existing, False

    def record_use(self, skill_id: int) -> None:
        """复用计量：引用技能的方案生成时 use_count + 1。"""
        skill = self.session.get(VerificationSkill, skill_id)
        if skill is not None:
            skill.use_count += 1
            self.session.flush()

    def match_uses(self, steps: list[dict]) -> list[VerificationSkill]:
        """结构匹配：方案步骤与某技能模板动作序列一致且逐步参数键集合一致
        （参数值已替换实参）-> 判定为引用了该技能。
        """
        return [skill for skill in self.list_active()
                if _steps_match_template(steps, skill.template_steps or [])]


def _steps_match_template(steps: list[dict], template: list[dict]) -> bool:
    if not template or len(steps) != len(template):
        return False
    for step, tmpl in zip(steps, template):
        if step.get("action") != tmpl.get("action"):
            return False
        if set((step.get("params") or {}).keys()) != set((tmpl.get("params") or {}).keys()):
            return False
    return True


def render_skill_library(skills: list[VerificationSkill]) -> str:
    """渲染 {skill_library} 动态段（名称/参数签名/描述 + 步骤模板）。"""
    if not skills:
        return "(暂无可用技能)"
    import json

    lines = []
    for skill in skills:
        lines.append(f"- {skill.name}({skill.params_signature}): {skill.desc}")
        lines.append(f"  步骤模板: {json.dumps(skill.template_steps, ensure_ascii=False)}")
    return "\n".join(lines)
