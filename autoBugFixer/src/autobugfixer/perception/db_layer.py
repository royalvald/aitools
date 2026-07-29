"""数据库层感知（设计文档 4.2.2 数据库维度）。

按验证方案中的数据检查点（query_db/assert_db）执行只读 SQL，
强制 SELECT 白名单校验（复用 pipeline.dsl 的只读约束与断言语义），
输出记录完整性/一致性检查结果。
"""

from __future__ import annotations

from autobugfixer.pipeline.dsl import (
    DSLInterpreter,
    DSLRuntime,
    DSLStep,
    _check_readonly_sql,  # 复用 DSL 只读白名单约束（11.4）
)

from .base import (
    DBCheckpoint,
    DBObservation,
    ObservationContext,
    PerceptionException,
)

DB_ACTIONS = {"query_db", "assert_db"}

_SAMPLE_ROWS = 5  # 检查点样本行数上限


class DBPerception:
    """数据库层感知适配器：经 DSLRuntime（EnvExecutor）执行只读 SQL。"""

    dimension = "db"

    def __init__(self, runtime: DSLRuntime) -> None:
        self.runtime = runtime

    def observe(self, steps: list[DSLStep], ctx: ObservationContext) -> DBObservation | None:
        """执行只读 SQL 检查点，输出记录完整性/一致性观测结果。"""
        db_steps = [s for s in steps if s.action in DB_ACTIONS]
        if not db_steps:
            return None
        obs = DBObservation()
        interpreter = DSLInterpreter(self.runtime)  # 复用 assert_db 的 expect 语义
        for step in db_steps:
            sql = step.params.get("sql", "")
            # 只读强校验：非 SELECT 直接拒绝，不触碰数据库
            try:
                _check_readonly_sql(sql)
            except ValueError as exc:
                obs.exceptions.append(PerceptionException(
                    dimension="db", kind="readonly_rejected", key=sql, detail=str(exc)))
                continue
            if step.action == "query_db":
                self._do_query(sql, obs)
            else:  # assert_db：交给 DSL 解释器保持断言语义一致
                result = interpreter.execute([step])[0]
                obs.checkpoints.append(DBCheckpoint(
                    sql=sql, passed=result.passed, detail=result.detail))
                if not result.passed:
                    obs.exceptions.append(PerceptionException(
                        dimension="db", kind="assert_failed", key=sql, detail=result.detail))
        return obs

    def _do_query(self, sql: str, obs: DBObservation) -> None:
        try:
            rows = self.runtime.query_db(sql)
        except Exception as exc:
            obs.checkpoints.append(DBCheckpoint(sql=sql, passed=False, detail=str(exc)[:300]))
            obs.exceptions.append(PerceptionException(
                dimension="db", kind="sql_error", key=sql, detail=str(exc)[:300]))
            return
        obs.checkpoints.append(DBCheckpoint(
            sql=sql, row_count=len(rows), sample=rows[:_SAMPLE_ROWS],
            passed=True, detail=f"返回 {len(rows)} 行"))
