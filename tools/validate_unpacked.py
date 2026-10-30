"""Offline validation of the exact directory selected by Load unpacked.

This checks local files and references, without launching a browser or reading a profile.
It is not a replacement for loading the extension in a real browser.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
from urllib.parse import unquote, urlsplit


class LoadError(ValueError):
    pass


def _relative(value: str, parent: str = '') -> str:
    if not isinstance(value, str) or not value or '\\' in value:
        raise LoadError('Invalid local reference')
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        raise LoadError('Remote or absolute runtime reference')
    value = unquote(parsed.path)
    if not value or ':' in value or value.startswith('/') or '..' in PurePosixPath(value).parts:
        raise LoadError('Unsafe runtime reference')
    return (PurePosixPath(parent) / value).as_posix()


def validate_content(content: dict[str, bytes]) -> dict:
    if 'manifest.json' not in content:
        raise LoadError('manifest.json is missing from the selected folder root; select the runtime folder, not the source repository')
    folded = set()
    for name, data in content.items():
        if _relative(name) != name or name.casefold() in folded:
            raise LoadError('Unsafe or duplicate package member')
        folded.add(name.casefold())
        if not isinstance(data, bytes):
            raise LoadError('Expected file bytes')
    try:
        manifest = json.loads(content['manifest.json'].decode('utf-8'))
    except (UnicodeError, ValueError) as exc:
        raise LoadError('manifest.json must be valid UTF-8 JSON without BOM') from exc
    if manifest.get('manifest_version') not in (2, 3) or not manifest.get('name'):
        raise LoadError('Unsupported manifest')
    if not re.fullmatch(r'\d+(?:\.\d+){0,3}', manifest.get('version', '')):
        raise LoadError('Invalid extension version')
    refs = []
    background = manifest.get('background', {})
    refs += background.get('scripts', [])
    if background.get('service_worker'):
        refs.append(background['service_worker'])
    for key in ('action', 'browser_action', 'page_action'):
        action = manifest.get(key, {})
        if action.get('default_popup'):
            refs.append(action['default_popup'])
        icons = action.get('default_icon', {})
        refs += list(icons.values()) if isinstance(icons, dict) else [icons] if icons else []
    refs += list(manifest.get('icons', {}).values())
    for script in manifest.get('content_scripts', []):
        refs += script.get('js', []) + script.get('css', [])
    if manifest.get('options_page'):
        refs.append(manifest['options_page'])
    if manifest.get('options_ui', {}).get('page'):
        refs.append(manifest['options_ui']['page'])
    for name, data in content.items():
        if name.endswith(('.html', '.js', '.mjs', '.css')):
            try:
                text = data.decode('utf-8')
            except UnicodeError as exc:
                raise LoadError('Runtime text must be UTF-8: ' + name) from exc
            parent = str(PurePosixPath(name).parent)
            local = []
            if name.endswith('.html'):
                local += re.findall(r'(?:src|href)=["\']([^"\']+)["\']', text)
            if name.endswith(('.js', '.mjs')):
                for args in re.findall(r'\bimportScripts\(([^)]+)\)', text):
                    local += re.findall(r'["\']([^"\']+)["\']', args)
                local += re.findall(r'\bfrom\s+["\']([^"\']+)["\']', text)
                # getURL paths are extension-root relative, unlike importScripts.
                refs += re.findall(r'\bruntime\.getURL\(["\']([^"\']+)["\']\)', text)
            if name.endswith('.css'):
                local += re.findall(r'url\(["\']?([^\)"\']+)', text)
            for value in local:
                if value.startswith(('#', 'data:')):
                    continue
                refs.append(_relative(value, parent))
    for value in refs:
        path = _relative(value)
        if path not in content:
            raise LoadError('Missing runtime reference: ' + path)
    return dict(name=manifest['name'], version=manifest['version'], manifestAtRoot=True,
                files=len(content), checkedReferences=len(refs), browserLoadTested=False)


def validate_directory(root: Path) -> dict:
    root = Path(root).absolute()
    if not root.is_dir() or root.is_symlink() or getattr(root, 'is_junction', lambda: False)():
        raise LoadError('Expected a normal runtime directory')
    if not (root / 'manifest.json').is_file():
        raise LoadError('manifest.json is missing from the selected folder root; select the runtime folder, not the source repository')
    content = {}
    for path in root.rglob('*'):
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise LoadError('Runtime directory contains a link or junction')
        if path.is_file():
            content[path.relative_to(root).as_posix()] = path.read_bytes()
    return validate_content(content)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(validate_directory(args.directory), ensure_ascii=False))
    except (LoadError, OSError) as exc:
        parser.exit(1, 'NOT LOADABLE: ' + str(exc) + '\n')
