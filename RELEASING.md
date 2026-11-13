# Putting out a new version

Everything is built on GitHub's machines. You do not build anything yourself —
you change a number, write down what changed, and push a tag.

## The five steps

Say the current version is 0.98.3 and you are putting out 0.98.4.

**1. Set the version.** In `package.json`, change the `"version"` line:

```json
"version": "0.98.4",
```

Use 0.98.**4** for fixes, 0.**99**.0 for new features, **1**.0.0 for something
that changes how it works from top to bottom.

**2. Write down what changed.** In `CHANGELOG.md`, add a section above the
previous one. Keep the heading in exactly this shape, or the release notes
come out empty:

```markdown
## [0.98.4] - 2026-12-01

### Fixed

- Subtitles no longer drift out of sync on long files.
```

**3. Commit it.**

```bash
git add package.json CHANGELOG.md
git commit -m "release: 0.98.4"
git push
```

**4. Tag it.** The `v` matters.

```bash
git tag v0.98.4
git push origin v0.98.4
```

**5. Wait about three minutes.** Pushing the tag starts the build. Watch it at
[the Actions tab](https://github.com/helalsaeed2003/StreamTorrent/actions), or
from the terminal:

```bash
gh run watch
```

When it goes green the release is live at
[Releases](https://github.com/helalsaeed2003/StreamTorrent/releases), with the
installer, the portable zip, and the two files the updater needs.

That is it. Everyone running the installed version gets it within a few hours,
or straight away if they restart the app.

## If the build fails

It will tell you which step. The two usual ones:

- **"The tag says 0.98.4 but package.json says 0.98.3"** — you tagged before
  committing the version bump. Delete the tag and do it again:

  ```bash
  git push --delete origin v0.98.4
  git tag -d v0.98.4
  ```

  then fix `package.json`, commit, push, and tag again.

- **"CHANGELOG.md has no section for 0.98.4"** — the heading does not match.
  It has to start `## [0.98.4]` or `## 0.98.4`.

You can also rebuild a tag that is already pushed without touching anything:
Actions → Release → **Run workflow** → type the tag.

## Checking it reached your friend

On his machine, in the installed app:

1. **Help → About** shows the version he has.
2. **Help → Check for Updates** asks right now instead of waiting.
   - Newer version out → it downloads quietly, then
     **Update ready: restart to install**. He clicks **Restart now** and
     About shows the new number.
   - Nothing newer → it says so.
3. If a video is playing, the offer waits until it stops. That is deliberate.
4. Left for later, it installs itself the next time he quits the app.

Nothing he has is lost in an update — the torrent list, how far he got in each
video, subtitle choices and settings live in
`%LOCALAPPDATA%\StreamTorrentData`, which the installer never touches.

If he is on the **portable** zip, it does not update itself. It tells him a new
version is out and offers to open the Releases page, and he unzips the new one
over the old folder, keeping `Portable Settings`.

## A note on mpv

The build downloads mpv from a copy kept on this repository's own releases,
and falls back to the original upstream build. Upstream clears its nightly
builds away after about a month. If a build ever fails at the **Fetch mpv**
step saying it could not download, that is why — the fix is to upload the
archive to a release here and make sure `MPV.mirror` in
[`bin/fetch-mpv.js`](bin/fetch-mpv.js) points at it.
