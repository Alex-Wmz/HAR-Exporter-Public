"""Offline tests for generic and directory-preset distribution packages."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build_har_packages as builder
from validate_unpacked import LoadError, validate_content, validate_directory


class BuildTests(unittest.TestCase):
    def test_public_runtime_packages_include_the_exact_license_and_notices(self):
        with tempfile.TemporaryDirectory() as directory:
            for browser in ('chrome', 'firefox'):
                record = builder.build(browser, Path(directory))
                with zipfile.ZipFile(Path(directory) / record['file']) as archive:
                    sums = archive.read('SHA256SUMS.txt').decode('utf-8')
                    for name in builder.PUBLIC_LICENSE_FILES:
                        data = archive.read(name)
                        expected = (builder.PUBLIC_ROOT / name).read_bytes().replace(b'\r\n', b'\n')
                        self.assertEqual(data, expected)
                        self.assertIn(builder.digest(data) + '  ' + name, sums)

    def test_download_zip_extracts_to_a_directly_selectable_runtime_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            record = builder.build('chrome', output)
            with zipfile.ZipFile(output / record['file']) as archive:
                self.assertIn('manifest.json', archive.namelist())
                self.assertIn('安装指引.html', archive.namelist())
                archive.extractall(output / 'runtime')
            result = validate_directory(output / 'runtime')
            self.assertEqual(result['version'], record['version'])
            self.assertTrue(result['manifestAtRoot'])
            self.assertFalse(result['browserLoadTested'])

    def test_source_repository_root_is_rejected_with_useful_error(self):
        with self.assertRaisesRegex(LoadError, 'folder root'):
            validate_directory(builder.TOOLS.parent)

    def test_missing_worker_popup_icon_and_offscreen_script_are_detected(self):
        source = builder.TOOLS / 'har-exporter'
        content = {name: (source / name).read_bytes() for name in builder.FILES['chrome']}
        for name in ('background.js', 'popup.html', 'icons/icon16.png', 'offscreen.js', 'resource-export.js'):
            incomplete = {key: value for key, value in content.items() if key != name}
            with self.subTest(missing=name), self.assertRaises(LoadError):
                validate_content(incomplete)

    def test_manifest_encoding_and_unsafe_references_are_rejected(self):
        source = builder.TOOLS / 'har-exporter'
        content = {name: (source / name).read_bytes() for name in builder.FILES['chrome']}
        bad = dict(content, **{'manifest.json': b'\xef\xbb\xbf' + content['manifest.json']})
        with self.assertRaises(LoadError):
            validate_content(bad)
        for url in ('../outside.js', 'https://example.invalid/remote.js', 'foo.js:stream'):
            bad = dict(content, **{'popup.html': ('<script src="' + url + '"></script>').encode()})
            with self.subTest(reference=url), self.assertRaises(LoadError):
                validate_content(bad)

    def test_windows_and_git_checkout_line_endings_produce_identical_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            output = workspace / 'packages'
            output.mkdir()
            expected = builder.build('chrome', output)['sha256']
            source = workspace / 'tools'
            for name in builder.FILES['chrome']:
                target = source / 'har-exporter' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                data = (builder.TOOLS / 'har-exporter' / name).read_bytes()
                if not name.endswith('.png'):
                    data = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
                target.write_bytes(data)
            with patch.object(builder, 'TOOLS', source):
                actual = builder.build('chrome', output)['sha256']
            self.assertEqual(actual, expected)

    def test_path_validation(self):
        self.assertEqual(builder.validate_default_folder("Z:/Example/HARExports"), "Z:\\Example\\HARExports")
        for path in ("relative", "Z:\\", "Z:\\Example\\..\\elsewhere", "\\\\server\\share", "Z:\\bad?name"):
            with self.assertRaises(ValueError):
                builder.validate_default_folder(path)

    def test_generic_and_preset_packages_differ_only_in_config_and_instructions(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            generic = builder.build("chrome", output)
            local = builder.build("chrome", output, "Z:\\Example\\HARExports")
            with zipfile.ZipFile(output / generic["file"]) as normal, zipfile.ZipFile(output / local["file"]) as preset:
                self.assertEqual(set(normal.namelist()), set(preset.namelist()))
                differences = {name for name in normal.namelist() if normal.read(name) != preset.read(name)}
                self.assertEqual(differences, {"export-config.js", "使用说明.txt", "SHA256SUMS.txt"})
                self.assertIn(b"defaultFolderPath: ''", normal.read("export-config.js"))
                self.assertEqual(preset.read("export-config.js"), builder.export_config("Z:\\Example\\HARExports"))
                current = json.loads((builder.TOOLS / "har-exporter" / "manifest.json").read_text(encoding="utf-8"))["version"]
                self.assertEqual(json.loads(normal.read("manifest.json"))["version"], current)
                for name in ("resources.js", "resource-export.js", "resources.html", "resources-page.js"):
                    self.assertIn(name, normal.namelist())
                self.assertNotIn("test/resources-mock.js", normal.namelist())

    def test_private_context_exemption_applies_to_exact_generated_config_only(self):
        path = "Z:\\Example\\HARExports"
        builder.inspect_text("export-config.js", builder.export_config(path), path)
        with self.assertRaises(AssertionError):
            builder.inspect_text("popup.js", builder.export_config(path), path)
        with self.assertRaises(AssertionError):
            builder.inspect_text("export-config.js", builder.export_config(path) + b"// unexpected", path)


if __name__ == "__main__":
    unittest.main()
