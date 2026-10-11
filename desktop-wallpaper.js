function buildDesktopWallpaperScript(filePath, desktopCount) {
  const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const desktopScripts = Array.from({ length: desktopCount }, (_, index) => {
    const desktopIndex = index + 1;
    return `set picture of desktop ${desktopIndex} to POSIX file "${escapedPath}"`;
  });

  return `tell application "System Events"\n${desktopScripts.join('\n')}\nend tell`;
}

module.exports = {
  buildDesktopWallpaperScript,
};
