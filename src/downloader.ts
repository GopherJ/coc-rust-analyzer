import { exec } from 'child_process';
import { ExtensionContext, workspace } from 'coc.nvim';
import { createWriteStream, PathLike, promises as fs } from 'fs';
import fetch from 'node-fetch';
import os from 'os';
import { join } from 'path';
import stream from 'stream';
import util from 'util';
import { UpdatesChannel } from './config';

const pipeline = util.promisify(stream.pipeline);

async function patchelf(dest: PathLike): Promise<void> {
  const expression = `
{src, pkgs ? import <nixpkgs> {}}:
    pkgs.stdenv.mkDerivation {
        name = "rust-analyzer";
        inherit src;
        phases = [ "installPhase" "fixupPhase" ];
        installPhase = "cp $src $out";
        fixupPhase = ''
        chmod 755 $out
        patchelf --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" $out
        '';
    }
`;
  const origFile = dest + '-orig';
  await fs.rename(dest, origFile);

  await new Promise((resolve, reject) => {
    const handle = exec(`nix-build -E - --arg src '${origFile}' -o ${dest}`, (err, stdout, stderr) => {
      if (err != null) {
        reject(Error(stderr));
      } else {
        resolve(stdout);
      }
    });
    handle.stdin?.write(expression);
    handle.stdin?.end();
  });

  await fs.unlink(origFile);
}

export interface ReleaseTag {
  tag: string;
  url: string;
  name: string;
}

export async function getLatestRelease(updatesChannel: UpdatesChannel): Promise<ReleaseTag | undefined> {
  const fix = { win32: '-windows', darwin: '-mac' }[os.platform()] || '-linux';
  let releaseURL = 'https://api.github.com/repos/rust-analyzer/rust-analyzer/releases/latest';
  if (updatesChannel === 'nightly') {
    releaseURL = 'https://api.github.com/repos/rust-analyzer/rust-analyzer/releases/tags/nightly';
  }
  return fetch(releaseURL)
    .then((resp) => resp.json())
    .then((resp) => {
      const asset = (resp.assets as any[]).find((val) => val.browser_download_url.includes(fix));
      const name = (asset.name as string).replace(fix, '');
      let tag = resp.tag_name;
      if (updatesChannel === 'nightly') {
        tag = `${resp.tag_name} ${resp.published_at.slice(0, 10)}`;
      }
      return { tag, url: asset.browser_download_url, name };
    })
    .catch(() => {
      return undefined;
    });
}

export async function downloadServer(context: ExtensionContext, updatesChannel: UpdatesChannel): Promise<void> {
  const statusItem = workspace.createStatusBarItem(0, { progress: true });
  statusItem.text = 'Getting the latest version...';
  statusItem.show();

  const latest = await getLatestRelease(updatesChannel);
  if (!latest) {
    statusItem.hide();
    workspace.showMessage(`Can't get latest rust-analyzer release`);
    return;
  }

  const _path = join(context.storagePath, latest.name);
  statusItem.text = `Downloading rust-analyzer ${latest.tag}`;

  const resp = await fetch(latest.url);
  // const resp = await fetch('http://devd.io/rust-analyzer');
  if (!resp.ok) {
    statusItem.hide();
    throw new Error('Download failed');
  }

  let cur = 0;
  const len = Number(resp.headers.get('content-length'));
  resp.body.on('data', (chunk: Buffer) => {
    cur += chunk.length;
    const p = ((cur / len) * 100).toFixed(2);
    statusItem.text = `${p}% Downloading rust-analyzer ${latest.tag}`;
  });

  const destFileStream = createWriteStream(_path, { mode: 0o755 });
  await pipeline(resp.body, destFileStream);

  await context.globalState.update('release', latest.tag);

  try {
    if (await fs.stat('/etc/nixos')) {
      statusItem.text = `Patching rust-analyzer executable...`;
      await patchelf(_path);
    }
  } catch (e) {}

  statusItem.hide();
}
