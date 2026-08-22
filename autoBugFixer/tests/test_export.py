"""知识库导出测试（FR-SYS-03）：Markdown 渲染 + 脱敏 + API/CLI 出口。"""

from fastapi.testclient import TestClient

from autobugfixer.api.app import create_app
from autobugfixer.cli.export_cli import main as export_main
from autobugfixer.features.knowledge.experience import ExperienceService
from autobugfixer.features.knowledge.export import render_markdown


def _seed(session_factory):
    with session_factory() as s:
        service = ExperienceService(s)
        service.save(category="接口类", problem_signature="健康检查返回 fail",
                     fix_pattern="改 status 字段；连接串 password=topsecret123 勿外泄",
                     verification_points="断言 status=ok", applicable_conditions="env=v1")
        service.save(category="界面类", problem_signature="按钮文案错误",
                     fix_pattern="修改文案", source_task_ids=[1])
        s.commit()


def test_render_markdown_grouped_and_redacted(session_factory):
    _seed(session_factory)
    with session_factory() as s:
        md = render_markdown(s)
    assert md.startswith("# autobugfixer 修复经验知识库")
    assert "## 接口类" in md and "## 界面类" in md
    assert "topsecret123" not in md  # 凭据已脱敏
    assert "password=***" in md


def test_api_export_endpoint(settings, session_factory):
    _seed(session_factory)
    client = TestClient(create_app(settings))
    resp = client.get("/api/experiences/export?format=markdown")
    assert resp.status_code == 200
    assert "知识库" in resp.text
    assert "topsecret123" not in resp.text
    assert client.get("/api/experiences/export?format=pdf").status_code == 400


def test_cli_export(settings, session_factory, tmp_path):
    _seed(session_factory)
    out = tmp_path / "kb.md"
    assert export_main(["--format", "markdown", "--out", str(out)],
                       settings=settings) == 0
    content = out.read_text(encoding="utf-8")
    assert "## 接口类" in content and "topsecret123" not in content
