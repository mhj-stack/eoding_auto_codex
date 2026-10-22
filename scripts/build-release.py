"""Build a source-only release from explicit public source directories."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins/eoding-product-register'


def build(output):
    version = json.loads((PLUGIN / 'plugin.json').read_text('utf-8'))['version']
    names = ['README.md', 'LICENSE', '.gitignore', '.gitattributes',
             '.agents/plugins/marketplace.json', '.github/workflows/test.yml', 'scripts/build-release.py']
    plugin_names = ['plugin.json', 'mcp.json', 'package.json', 'package-lock.json',
                    'requirements.txt', 'LICENSE', 'PLUGIN-README.md', 'Install.cmd']
    for folder in ['src', 'scripts', 'skills', 'examples', 'docs', 'tests']:
        plugin_names.extend(p.relative_to(PLUGIN).as_posix() for p in sorted((PLUGIN / folder).rglob('*')) if p.is_file())
    names += ['plugins/eoding-product-register/' + name for name in plugin_names]
    files = {}
    for name in sorted(names):
        source = ROOT / name
        if source.is_symlink() or not source.resolve().is_relative_to(ROOT):
            raise ValueError('Unsafe source: ' + name)
        raw = source.read_bytes()
        text = raw.decode('utf-8-sig')
        if re.search(r'(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)', text):
            raise ValueError('Credential marker in ' + name)
        if any(part in {'.local', '.git', 'node_modules', '.venv', '__pycache__', 'evidence', 'profiles', 'runtimes'} for part in Path(name).parts):
            raise ValueError('Private or generated source in ' + name)
        files[name] = raw
    manifest = {'name': 'eoding-auto-codex', 'version': version, 'sourceOnly': True, 'liveErpVerified': False,
                'files': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest()} for name, data in files.items()]}
    files['PACKAGE-MANIFEST.json'] = (json.dumps(manifest, indent=2) + '\n').encode('utf-8')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'eoding-auto-codex-{version}.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr('eoding-auto-codex/' + name, data)
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for item in manifest['files']:
            assert hashlib.sha256(z.read('eoding-auto-codex/' + item['path'])).hexdigest() == item['sha256']
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{checksum}  {archive.name}\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'files': len(files), 'sha256': checksum}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=str(ROOT / 'dist'))
    build(Path(parser.parse_args().output).resolve())
