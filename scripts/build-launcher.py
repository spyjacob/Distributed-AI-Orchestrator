"""Build the Finder launcher beside the project, without Electron."""
from pathlib import Path
import plistlib
import subprocess

ROOT = Path(__file__).resolve().parent.parent

def build():
    bundle = ROOT / 'Launch Distributed Orchestrator.app'
    contents = bundle / 'Contents'
    binary = contents / 'MacOS' / 'OrchestratorLauncher'
    binary.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['swiftc', str(ROOT / 'scripts/launcher.swift'), '-o', str(binary)], check=True)
    with (contents / 'Info.plist').open('wb') as output:
        plistlib.dump({
            'CFBundleExecutable': 'OrchestratorLauncher',
            'CFBundleIdentifier': 'dev.orchestrator.launcher',
            'CFBundleName': 'Distributed Orchestrator',
            'CFBundleDisplayName': 'Distributed Orchestrator',
            'CFBundlePackageType': 'APPL',
            'CFBundleVersion': '1',
            'NSHighResolutionCapable': True,
        }, output)
    subprocess.run(['codesign', '--force', '--sign', '-', str(bundle)], check=True)
    return bundle

if __name__ == '__main__':
    print(build())
