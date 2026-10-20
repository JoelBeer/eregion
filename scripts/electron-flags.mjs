// Prints the Electron flags for this machine. Inside WSL, Eregion runs as a Wayland client: under X11, WSLg
// can't drag or minimise a window that draws its own title bar. Chromium picks its display backend before the
// app's code runs, so this has to be on the command line (see "start" and "dev" in package.json).
const insideWsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
process.stdout.write(insideWsl ? '--ozone-platform=wayland' : '--ozone-platform-hint=auto')
