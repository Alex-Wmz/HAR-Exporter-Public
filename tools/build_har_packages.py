"""Build minimal, reproducible colleague ZIPs. Never reads browser or HAR data."""
from __future__ import annotations

import argparse
import hashlib
import json
import ntpath
from pathlib import Path
import re
import struct
import tempfile
import zipfile
import zlib

from validate_unpacked import validate_content, validate_directory

TOOLS = Path(__file__).resolve().parent
PUBLIC_ROOT = TOOLS.parent
PUBLIC_LICENSE_FILES = ("LICENSE", "NOTICE", "COMMERCIAL_LICENSE.md")
ICONS = tuple(f"icons/icon{n}.png" for n in (16, 48, 128))
FILES = {
    "chrome": ("manifest.json", "background.js", "capture.js", "payload-policy.js", "export-config.js", "fs-store.js",
               "offscreen.html", "offscreen.js", "picker.html", "picker.js", "popup.html", "popup.js", "recent-export.js",
               "resources.js", "resource-export.js", "resources.html", "resources-page.js", *ICONS),
    "firefox": ("manifest.json", "background.js", "recorder.js", "payload-policy.js", "popup.html", "popup.js", "popup.css", *ICONS),
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def inspect_png(data: bytes) -> None:
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "Invalid PNG"
    pos = 8
    kinds = []
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + length]
        crc = struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])[0]
        assert zlib.crc32(kind + payload) & 0xFFFFFFFF == crc, "Invalid PNG CRC"
        assert kind in {b"IHDR", b"IDAT", b"IEND"}, "Unexpected image metadata"
        kinds.append(kind)
        pos += length + 12
    assert pos == len(data) and kinds[0] == b"IHDR" and kinds[-1] == b"IEND"


def export_config(default_folder: str) -> bytes:
    return ("// Generated local default; select and authorize this folder once in Chrome.\n"
            "self.HarExportConfig = Object.freeze(" + json.dumps({"defaultFolderPath": default_folder}, ensure_ascii=False) + ");\n").encode("utf-8")


def validate_default_folder(value: str) -> str:
    path = value.replace("/", "\\")
    drive, tail = ntpath.splitdrive(path)
    parts = tail.strip("\\").split("\\")
    if (not re.fullmatch(r"[A-Za-z]:", drive) or not tail.startswith("\\") or
            not all(part and part not in {".", ".."} and part == part.rstrip(" .") and
                    not re.search(r'[<>:"|?*\x00-\x1f]', part) for part in parts)):
        raise ValueError("Default folder must be an absolute Windows directory without traversal or invalid characters")
    return drive + "\\" + "\\".join(parts)


def inspect_text(name: str, data: bytes, default_folder: str = "") -> None:
    text = data.decode("utf-8")
    if name == "export-config.js" and default_folder:
        assert data == export_config(default_folder), "Unexpected default config contents"
        # The explicit user-supplied output path is the sole allowed local path.
        text = export_config("").decode("utf-8")
    forbidden = {
        "local-path": r"\b[A-Za-z]:[\\/]|/Users/|\\Users\\",
        "private-context": r"wxid_|xwechat_files",
        "business-host": r"internal-company-host\.invalid",
        "editor-residue": r"data-page-node-id|sourceMappingURL",
        "credential-value": r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
    }
    for label, pattern in forbidden.items():
        assert not re.search(pattern, text, re.I), f"{name}: unexpected {label}; inspect locally"
    local_name = Path.home().name
    if len(local_name) >= 5:
        assert local_name not in text, f"{name}: unexpected local account name"
    emails = re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text)
    assert set(emails) <= {"har-exporter@local.invalid"}, f"{name}: unexpected email address"


def usage(browser: str, version: str, default_folder: str = "") -> bytes:
    install = (
        "适用 Chrome 125+，或相当版本的 Edge。\n"
        "解压到固定文件夹，打开 chrome://extensions/（Edge 为 edge://extensions/），开启开发者模式，"
        "选择“加载已解压的扩展程序”，选含 manifest.json 的文件夹。\n"
        "只下载本项目 Release 的运行包；GitHub 的 Source code ZIP 最外层是源码，不能直接加载。\n"
        "解压后先确认所选文件夹直接包含 manifest.json；不要选 ZIP 文件、源码仓库根目录或它们的上级文件夹。\n"
        "首次选择无版本号的固定目录；以后结束录制/导出/保存，用新版运行文件更新同一目录，再点击扩展卡片的“重新加载”。\n"
        "浏览器的更新按钮不会替你从 GitHub 下载文件。不要为升级卸载扩展或清理浏览器数据。\n"
        "迁移到新目录前导出重要素材；扩展身份可能改变，保存位置可能需要重新授权。不要同时开启两份录制插件。\n"
        "保存可选择目录记忆或每次另存为；预设目录失效时保留录制并提示重新授权，也可明确选择另存为。\n"
        "1.4.4 新增“最近成功保存”：查看文件名、时间及保存位置，重开浏览器后仍保留最近一条记录，可手动清除。\n"
        "“每次询问”保存后可在系统文件夹中显示文件、复制完整路径；记忆目录点击“浏览…”打开该目录的系统文件选择窗口，查看后取消即可。\n"
        "记忆目录不提供完整路径或直接打开资源管理器；可以查看文件选择窗口的地址栏。升级前的文件不会自动补入记录，但旧记忆目录仍可浏览。\n"
        "1.5.0新增已捕获资源列表：录制期间或待导出时点“查看已捕获资源”，按类型/大小/名称筛选、折叠重复地址。正文只从本轮已有数据逐文件另存为，不重新请求网站。\n"
        "请在成功导出HAR之前保存需要的资源；HAR保存成功或放弃录制仍清空本轮内存。媒体正文须在录制前选择包含，分段响应不能当完整视频导出。\n"
        + ("本包已预设本机默认目录。重载后点击“设置默认目录”，首次在系统窗口选择并授权、核对地址栏后确认。默认目录不可写时保留录制并提示，不自动改存其它位置。\n" if default_folder else
           "本包为通用版，保留已有保存偏好。可以自行选择并记住文件夹。\n")
    ) if browser == "chrome" else (
        "适用 Firefox 桌面版 142+。当前 ZIP 未经 Mozilla 签名。\n"
        "解压后打开 about:debugging#/runtime/this-firefox，点击“临时载入附加组件”，选 manifest.json。\n"
        "更新前先导出旧版录制，再移除旧临时插件并加载新目录。浏览器重启后需重新加载。\n"
        "不能把未签名 ZIP 改名 XPI 来永久安装；长期安装需要 Mozilla 签名。本包未上传或申请签名。\n"
        "保存使用 Firefox 另存为；不提供目录记忆，不保存 WebSocket 消息或 SSE 正文，"
        "不能关联标签的 worker 请求可能缺失。\n"
    )
    text = f"""HAR Exporter {version} — {browser.title()}

安装
{install}
使用
1. 打开普通网页，点击插件“开始录制”，再刷新或操作页面。
2. 默认跟随页面打开的新标签。图片、音视频和字体正文可在开始前选择包含。
3. 完成后“停止并导出 HAR”，已有请求最多再等 5 秒。
4. 取消保存或保存失败会保留本轮数据，可再次导出；关闭浏览器或重载插件会丢失未保存录制。

本版修复
1.4.5优先保留接口和导航网页正文，搜索结果HTML不再与普通脚本争抢16 MiB资源空间。
录制中显示容量和正文缺失数，出现缺失时图标显示 !。文件保存成功不代表所有正文完整。

容量
单条响应最多 10 MiB，请求正文最多 1 MiB；按保存的 UTF-8 文本大小（含 Base64 膨胀）累计。
请求正文独享 8 MiB；响应合计 56 MiB，其中普通网页资源最多 16 MiB，给接口与导航网页正文共同留出至少 40 MiB。
接口与网页正文共用响应区域剩余空间；未用的请求预算不借给响应。
Firefox 另限制临时响应原字节总量 32 MiB，其中普通资源最多 8 MiB；完成或丢弃均释放。
最多 10,000 条请求，元数据预算 16 MiB。以上不是浏览器进程内存或 HAR 文件体积的上限。

接口按请求类型、方法和响应内容类型自动识别；不预置网站、账号或客户信息。
站点配置、统计接口及其它网页也会占优先空间，不能保证所有业务正文都完整。
弹窗显示网页正文容量和非空数量；应在真实搜索结果加载完成后再导出，验证码页不等于搜索结果。
出现缺失提示应尽快保存，下一段重新开始录制；本版不自动分卷，录制间隔的请求不会补录。
HAR 的 log._capture 包含缺失数量、原因、预算及非空接口响应计数，incomplete=0 不代表正文完整。
浏览器可能无法提供已淘汰的正文、附加前请求或上传文件内容。首次使用请先做短段测试。

安装包内容与数据
本包仅包含扩展运行文件、通用图标、安装指引、本说明和 SHA256SUMS.txt。
不包含任何录制 HAR、浏览器资料、账号凭据、个人信息、业务数据、项目文档或测试样本。
扩展不主动上传数据；录制正文保存在内存和操作者另存为的 HAR 中。Chrome 持久设置包含偏好、保存目录和最近一条成功导出的文件名/时间/位置；名称及路径也可能含个人信息，仅保留在本机，可清除。
安装后新录出的 HAR 可能含 Cookie、Token、个人或支付资料；分享 HAR 前须自行检查脱敏。

验证边界
代码回归、合成负载及辅助界面检查通过；不承诺任意网站或同事设备上的所有响应完整。
"""
    return text.replace("\r\n", "\n").encode("utf-8")


def installation_guide(version: str) -> bytes:
    return ('''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>HAR Exporter 安装指引</title><style>body{font:18px/1.8 system-ui;max-width:760px;margin:48px auto;padding:20px}code{background:#eee;padding:4px}</style>
<h1>HAR Exporter ''' + version + ''' · Chrome / Edge</h1>
<p>浏览器要选的是：<strong>直接包含 manifest.json 的文件夹</strong>。</p>
<ol><li>先把本 ZIP 完整解压到准备长期保留的固定文件夹，不要只解压一个文件。</li>
<li>在地址栏输入 <code>edge://extensions</code> 或 <code>chrome://extensions</code>。</li>
<li>打开开发者模式，点“加载已解压的扩展程序”，选择本页所在文件夹。</li>
<li>确认扩展卡片显示版本 ''' + version + '''。</li></ol>
<p>不要选择 GitHub 源码 ZIP 的最外层、源码仓库根目录、ZIP 文件或固定目录的上级文件夹。</p>
<h2>以后更新</h2><p>先结束录制并导出重要内容，再把最新运行包更新到同一个固定文件夹，最后点扩展卡片的“重新加载”。
浏览器的更新按钮不会从 GitHub 下载文件。无需卸载，不清理素材或浏览器数据。</p>
<p>更换加载路径可能改变扩展身份。首次迁移前先导出重要素材，迁移后可能要重新授权保存目录。</p>
<p>新版运行包已经过解压目录与本地引用检查；真实浏览器/网站效果以各设备实测为准。</p></html>\n''').encode('utf-8')


def build(browser: str, output: Path, default_folder: str = "") -> dict:
    root = TOOLS / ("har-exporter" if browser == "chrome" else "har-exporter-firefox")
    content = {name: (root / name).read_bytes() for name in FILES[browser]}
    content = {name: data if name.endswith('.png') else data.replace(b'\r\n', b'\n')
               for name, data in content.items()}
    if default_folder:
        assert browser == "chrome", "Default folder preset is supported for Chrome only"
        default_folder = validate_default_folder(default_folder)
        content["export-config.js"] = export_config(default_folder)
    manifest = json.loads(content["manifest.json"])
    version = manifest["version"]
    refs = ([manifest["background"]["service_worker"], manifest["action"]["default_popup"]] if browser == "chrome"
            else [*manifest["background"]["scripts"], manifest["browser_action"]["default_popup"]])
    for name, data in content.items():
        if name.endswith(".png"):
            inspect_png(data)
        else:
            inspect_text(name, data, default_folder)
            if name.endswith(".html"):
                refs += re.findall(r'(?:src|href)=["\']([^"\']+)["\']', data.decode("utf-8"))
            if name.endswith(".js"):
                for call in re.findall(r"^\s*importScripts\(([^)]+)\)", data.decode("utf-8"), re.M):
                    refs += re.findall(r'["\']([^"\']+)["\']', call)
    assert all(ref in content for ref in refs), "Missing runtime reference"
    content["使用说明.txt"] = usage(browser, version, default_folder)
    inspect_text("使用说明.txt", content["使用说明.txt"])
    if browser == 'chrome':
        content['安装指引.html'] = installation_guide(version)
        inspect_text('安装指引.html', content['安装指引.html'])
    for name in PUBLIC_LICENSE_FILES:
        content[name] = (PUBLIC_ROOT / name).read_bytes().replace(b"\r\n", b"\n")
        inspect_text(name, content[name])
    validate_content(content)
    content["SHA256SUMS.txt"] = "".join(f"{digest(content[name])}  {name}\n" for name in sorted(content)).encode("utf-8")
    suffix = "-default" if default_folder else ""
    path = output / f"har-exporter-{version}-{browser}{suffix}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data in sorted(content.items()):
            info = zipfile.ZipInfo(name, (2026, 9, 14, 0, 0, 0))
            info.create_system = 0
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        assert set(z.namelist()) == set(content)
        assert z.comment == b""
        for info in z.infolist():
            assert not info.extra and not info.comment
            assert not info.filename.startswith(("/", "\\")) and ".." not in Path(info.filename).parts
            assert z.read(info) == content[info.filename]
        with tempfile.TemporaryDirectory() as unpacked:
            z.extractall(unpacked)
            load_check = validate_directory(Path(unpacked))
    return {"file": path.name, "version": version, "bytes": path.stat().st_size, "sha256": digest(path.read_bytes()),
            "fileCount": len(content), "files": {name: digest(data) for name, data in sorted(content.items())},
            "checks": ["allowlist", "utf8", "local-context-scan", "png-no-metadata", "runtime-references", "zip-crc", "byte-equality", "unpacked-root-manifest"],
            "unpacked": load_check}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--browser", choices=("chrome", "firefox", "all"), default="all")
    parser.add_argument("--default-folder", default="", help="Preset a Windows directory in a Chrome output package; requires one-time browser authorization")
    args = parser.parse_args()
    if args.default_folder and args.browser != "chrome":
        parser.error("--default-folder requires --browser chrome")
    args.output.mkdir(parents=True, exist_ok=True)
    assert (TOOLS / 'har-exporter/payload-policy.js').read_bytes() == (TOOLS / 'har-exporter-firefox/payload-policy.js').read_bytes()
    results = [build(browser, args.output, args.default_folder) for browser in FILES if args.browser in (browser, "all")]
    (args.output / "package-audit.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps([{k: v for k, v in row.items() if k != "files"} for row in results], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
