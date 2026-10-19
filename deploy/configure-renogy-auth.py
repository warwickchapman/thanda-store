#!/usr/bin/env python3
"""Configure automatic Renogy login on production without exposing secrets."""
import datetime
import getpass
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

CONFIG = Path('/etc/thanda-store-supplier.env')
APP = Path('/root/thanda-store/thanda-store')


def quoted(value):
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError('Credentials must not contain control characters.')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def main():
    if os.geteuid() != 0 or not CONFIG.is_file() or not APP.is_dir():
        raise SystemExit('Run as root on the Store production server with its existing supplier configuration.')
    if not sys.stdin.isatty():
        raise SystemExit('Use an interactive SSH terminal so credentials can be entered with hidden input.')
    email = getpass.getpass('Renogy partner email (hidden): ').strip()
    password = getpass.getpass('Renogy partner password (hidden): ')
    if not email or '@' not in email or not password:
        raise SystemExit('Both a partner email and password are required. Configuration unchanged.')
    values = {'RENOGY_EMAIL': quoted(email), 'RENOGY_PASSWORD': quoted(password)}
    original = CONFIG.read_text()
    updated = original
    for key, value in values.items():
        pattern = re.compile(r'^' + key + r'=.*$', re.MULTILINE)
        if pattern.search(updated):
            # This helper owns single-line entries. Avoid interpreting a
            # hand-written multi-line value or unrelated supplier settings.
            old = pattern.search(updated).group(0).split('=', 1)[1]
            if old.startswith('"') and not old.endswith('"'):
                raise SystemExit('Existing multi-line Renogy configuration requires manual review. No changes saved.')
            updated = pattern.sub(lambda _: key + '=' + value, updated)
        else:
            updated = updated.rstrip('\n') + '\n' + key + '=' + value + '\n'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = CONFIG.with_name(CONFIG.name + '.before-renogy-' + stamp)
    shutil.copy2(CONFIG, backup)
    backup.chmod(0o600)
    with tempfile.NamedTemporaryFile(mode='w', dir=CONFIG.parent, prefix='.renogy-config-', delete=False) as handle:
        temporary = Path(handle.name)
        os.fchmod(handle.fileno(), 0o600)
        handle.write(updated)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temporary, CONFIG)
    finally:
        temporary.unlink(missing_ok=True)
    print('Automatic Renogy login saved securely. Checking authentication only; stock is unchanged.')
    result = subprocess.run([
        'systemd-run', '--wait', '--pipe', '--collect', '--quiet',
        '--property=EnvironmentFile=' + str(CONFIG), '--property=WorkingDirectory=' + str(APP),
        '/usr/bin/node', 'scripts/sync-renogy-products.mjs', '--check-auth',
    ], check=False)
    if result.returncode:
        print('Credentials were saved, but authentication was not verified. Check the service output before retrying.')
        raise SystemExit(result.returncode)
    print('The normal five-minute supplier timer will refresh the catalogue and stock.')


if __name__ == '__main__':
    main()
