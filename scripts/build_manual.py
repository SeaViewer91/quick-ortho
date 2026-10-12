"""docs/MANUAL.md를 오프라인에서 열 수 있는 단일 HTML 파일로 만든다.

설치파일과 함께 배포(GitHub Releases 첨부, 앱 번들 포함)하는 용도임. 외부 글꼴·스크립트를 쓰지 않고
CSS·JS를 모두 파일 안에 넣으므로 인터넷 없이 브라우저에서 바로 열림.

사용:
    pip install markdown-it-py==4.2.0
    python scripts/build_manual.py --out build/manual/manual.html
    python scripts/build_manual.py --version 0.4.2 --out QuickOrtho_0.4.2_manual.html

--version을 생략하면 src-tauri/tauri.conf.json의 앱 버전을 씀.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
from pathlib import Path

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parent.parent
REPO_URL = "https://github.com/SeaViewer91/quick-ortho"


def app_version() -> str:
    return json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]


def doc_date() -> str:
    """빌드한 커밋의 날짜 (git이 없으면 빈 문자열). 같은 커밋이면 언제 빌드해도 결과가 같음.

    CI는 얕은 클론이라 파일별 마지막 수정 커밋을 알 수 없으므로 HEAD 날짜를 씀.
    """
    try:
        return subprocess.run(
            ["git", "log", "-1", "--format=%cs"], cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def rewrite_links(body: str, src: Path) -> str:
    """저장소 안 상대 링크는 GitHub 주소로, 바깥 링크는 새 창으로 열리게 바꾼다."""
    rel_dir = src.parent.relative_to(ROOT).as_posix()

    def fix(m: re.Match) -> str:
        href = html.unescape(m.group(1))
        if href.startswith("#"):
            return m.group(0)
        if not re.match(r"^[a-z]+:", href):
            target = (Path(rel_dir) / href).as_posix()
            href = f"{REPO_URL}/blob/main/{target}"
        return f'<a href="{html.escape(href, quote=True)}" target="_blank" rel="noopener"'

    return re.sub(r'<a href="([^"]*)"', fix, body)


def slugify(text: str, used: dict[str, int]) -> str:
    """GitHub과 같은 방식의 제목 앵커: 소문자, 문장부호 제거, 공백은 '-'. 같은 이름은 -1, -2를 붙임."""
    slug = re.sub(r"[^\w\- ]", "", text.strip().lower()).replace(" ", "-")
    n = used.get(slug, 0)
    used[slug] = n + 1
    return slug if n == 0 else f"{slug}-{n}"


def toc_html(heads: list[tuple[int, str, str]]) -> str:
    """(수준, id, 제목) 목록으로 2단계 목차를 만든다."""
    out, open_sub = ["<ol>"], False
    for i, (level, hid, name) in enumerate(heads):
        link = f'<a href="#{hid}">{html.escape(name)}</a>'
        if level == 2:
            if open_sub:
                out.append("</ol></li>")
                open_sub = False
            elif i:
                out.append("</li>")
            out.append(f"<li>{link}")
        else:
            if not open_sub:
                out.append("<ol>")
                open_sub = True
            out.append(f"<li>{link}</li>")
    out.append("</ol></li></ol>" if open_sub else "</li></ol>")
    return "".join(out)


def build(src: Path, version: str) -> str:
    text = src.read_text(encoding="utf-8")
    m = re.match(r"#\s+(.+)\n", text)
    title = m.group(1).strip() if m else "QuickOrtho 사용 매뉴얼"
    if m:
        text = text[m.end():]

    # CommonMark(GitHub과 같은 규칙: 목록 안 코드 블록, 2~3칸 들여쓴 하위 목록) + 표
    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    tokens = md.parse(text)
    used: dict[str, int] = {}
    heads: list[tuple[int, str, str]] = []
    for i, t in enumerate(tokens):
        if t.type == "heading_open":
            inline = tokens[i + 1]
            name = "".join(c.content for c in inline.children or [] if c.type in ("text", "code_inline")) or inline.content
            hid = slugify(name, used)
            t.attrSet("id", hid)
            level = int(t.tag[1])
            if level in (2, 3):
                heads.append((level, hid, name))
    body = md.renderer.render(tokens, md.options, {})
    body = re.sub(
        r'(<h([234]) id="([^"]+)">)(.*?)(</h\2>)',
        lambda m: f'{m.group(1)}{m.group(4)}<a class="headerlink" href="#{m.group(3)}" title="이 절의 링크">#</a>{m.group(5)}',
        body,
    )
    body = rewrite_links(body, src)
    # 표가 좁은 화면에서 가로로 넘치면 표만 스크롤되게 감싼다
    body = body.replace("<table>", '<div class="table-wrap"><table>').replace("</table>", "</table></div>")
    body = body.replace("<pre>", '<div class="code"><button type="button" class="copy" hidden>복사</button><pre>')
    body = body.replace("</pre>", "</pre></div>")

    date = doc_date()
    meta = f"v{html.escape(version)}" + (f" · {date} 기준" if date else "")
    return TEMPLATE.format(
        title=html.escape(title),
        meta=meta,
        toc=toc_html(heads),
        body=body,
        repo=REPO_URL,
        css=CSS,
        js=JS,
    )


CSS = r"""
:root {
  --bg: #fbfbfa; --surface: #ffffff; --text: #1d2125; --muted: #5d656d; --border: #e2e4e6;
  --accent: #0b6e8a; --accent-soft: #e6f2f5; --code-bg: #f3f4f5; --mark: #fff4d6;
  --font: "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "SF Mono", "Menlo", "Consolas", "D2Coding", "Noto Sans Mono", monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15181b; --surface: #1c2024; --text: #e3e6e8; --muted: #9aa3ab; --border: #2e3439;
    --accent: #5cc1db; --accent-soft: #1d3138; --code-bg: #23282d; --mark: #3a3420;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 16px; -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.7 var(--font); word-break: keep-all; overflow-wrap: break-word; }
a { color: var(--accent); }
.layout { display: grid; grid-template-columns: 264px minmax(0, 1fr); max-width: 1180px; margin: 0 auto; }
nav.toc { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto; padding: 28px 16px 28px 24px; border-right: 1px solid var(--border); font-size: 14px; }
nav.toc .brand { font-weight: 700; font-size: 15px; margin: 0 0 2px; }
nav.toc .meta { color: var(--muted); font-size: 12.5px; margin: 0 0 18px; }
nav.toc ol { list-style: none; margin: 0; padding: 0; }
nav.toc ol ol { padding-left: 12px; margin: 2px 0 6px; border-left: 1px solid var(--border); }
nav.toc li { margin: 1px 0; }
nav.toc a { display: block; padding: 3px 8px; border-radius: 6px; color: var(--muted); text-decoration: none; line-height: 1.45; }
nav.toc ol ol a { font-size: 13.5px; }
nav.toc a:hover { color: var(--text); background: var(--accent-soft); }
nav.toc a.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
main { padding: 40px 48px 96px; min-width: 0; }
header.doc { margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
header.doc h1 { font-size: 30px; line-height: 1.3; margin: 0 0 6px; letter-spacing: -0.01em; }
header.doc p { margin: 0; color: var(--muted); font-size: 14px; }
article { max-width: 46em; }
article h2 { font-size: 23px; margin: 52px 0 12px; padding-top: 4px; line-height: 1.35; letter-spacing: -0.01em; }
article h3 { font-size: 18.5px; margin: 34px 0 8px; line-height: 1.4; }
article h4 { font-size: 16px; margin: 26px 0 6px; }
article h2:first-child { margin-top: 0; }
.headerlink { margin-left: 6px; color: var(--border); text-decoration: none; font-weight: 400; opacity: 0; }
h2:hover .headerlink, h3:hover .headerlink, h4:hover .headerlink, .headerlink:focus { opacity: 1; color: var(--muted); }
p, ul, ol { margin: 0 0 14px; }
li { margin: 3px 0; }
li > ul, li > ol { margin: 4px 0 6px; }
code { font: 0.88em var(--mono); background: var(--code-bg); padding: 0.12em 0.38em; border-radius: 4px; }
.code { position: relative; margin: 10px 0 16px; }
pre { margin: 0; padding: 14px 16px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; line-height: 1.55; }
pre code { background: none; padding: 0; font-size: 13.5px; }
.copy { position: absolute; top: 8px; right: 8px; font: 12px var(--font); padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; }
.copy:hover { color: var(--text); }
.table-wrap { overflow-x: auto; margin: 10px 0 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; line-height: 1.55; }
th, td { padding: 8px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
th { background: var(--code-bg); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
blockquote { margin: 14px 0; padding: 10px 14px; background: var(--mark); border-radius: 8px; }
blockquote p:last-child { margin-bottom: 0; }
footer.doc { margin-top: 64px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.menu { display: none; }
@media (max-width: 860px) {
  .layout { display: block; }
  nav.toc { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 16px; }
  nav.toc .list { display: none; }
  nav.toc.open .list { display: block; margin-top: 10px; }
  .menu { display: inline-block; margin-top: 4px; font: 13px var(--font); padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }
  nav.toc .meta { margin-bottom: 4px; }
  main { padding: 24px 16px 64px; }
  header.doc h1 { font-size: 25px; }
}
@media print {
  body { background: #fff; color: #000; font-size: 11pt; }
  nav.toc, .copy, .headerlink, .menu { display: none !important; }
  .layout { display: block; }
  main { padding: 0; }
  article { max-width: none; }
  h2, h3, h4 { break-after: avoid; }
  pre, table, blockquote { break-inside: avoid; }
  a { color: inherit; }
}
"""

JS = r"""
(function () {
  // 코드 복사 버튼 (file://에서도 동작하도록 execCommand로 대체)
  document.querySelectorAll(".code").forEach(function (box) {
    var btn = box.querySelector(".copy"), pre = box.querySelector("pre");
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var text = pre.innerText.replace(/\n$/, "");
      var done = function () { btn.textContent = "복사됨"; setTimeout(function () { btn.textContent = "복사"; }, 1500); };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });
  // 좁은 화면의 목차 열고 닫기
  var nav = document.querySelector("nav.toc"), menu = document.querySelector(".menu");
  menu.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    menu.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll(".list a").forEach(function (a) {
    a.addEventListener("click", function () { nav.classList.remove("open"); menu.setAttribute("aria-expanded", "false"); });
  });
  // 지금 읽는 절을 목차에 표시
  var links = {};
  nav.querySelectorAll(".list a").forEach(function (a) { links[decodeURIComponent(a.hash.slice(1))] = a; });
  var heads = Array.prototype.filter.call(document.querySelectorAll("article h2[id], article h3[id]"), function (h) { return links[h.id]; });
  function update() {
    var cur = heads[0];
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top < 120) cur = heads[i]; else break;
    }
    Object.keys(links).forEach(function (k) { links[k].classList.toggle("active", cur && k === cur.id); });
  }
  var ticking = false;
  window.addEventListener("scroll", function () {
    if (!ticking) { ticking = true; requestAnimationFrame(function () { update(); ticking = false; }); }
  }, { passive: true });
  update();
})();
"""

TEMPLATE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<div class="layout">
<nav class="toc" aria-label="목차">
<p class="brand">{title}</p>
<p class="meta">QuickOrtho {meta}</p>
<button type="button" class="menu" aria-expanded="false">목차</button>
<div class="list">{toc}</div>
</nav>
<main>
<header class="doc">
<h1>{title}</h1>
<p>QuickOrtho {meta} · 최신 버전은 <a href="{repo}/blob/main/docs/MANUAL.md" target="_blank" rel="noopener">GitHub</a>에서 볼 수 있음</p>
</header>
<article>
{body}
</article>
<footer class="doc">QuickOrtho · MIT License · <a href="{repo}" target="_blank" rel="noopener">{repo}</a></footer>
</main>
</div>
<script>{js}</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--src", type=Path, default=ROOT / "docs" / "MANUAL.md")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--version", default=None, help="표시할 앱 버전 (기본: tauri.conf.json)")
    a = ap.parse_args()
    src = a.src.resolve()
    out = build(src, a.version or app_version())
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(out, encoding="utf-8", newline="\n")
    print(f"{a.out} ({len(out.encode('utf-8')) // 1024} KB)")


if __name__ == "__main__":
    main()
