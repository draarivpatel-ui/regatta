// The application menu. App commands show their shortcut but leave the key press to the renderer
// (registerAccelerator: false), so Cmd+W closes a pane instead of the window.

import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppCommand } from '../shared/ipc'

export function buildMenu(run: (command: AppCommand) => void): void {
  const cmd = (label: string, command: AppCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => run(command)
  })
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              cmd('Settings…', 'settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        cmd('New Pane…', 'new-pane', 'CmdOrCtrl+T'),
        cmd('Start a Crew…', 'crew'),
        { type: 'separator' },
        cmd('Close Pane', 'close-pane', 'CmdOrCtrl+W'),
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
        ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' } as MenuItemConstructorOptions])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        cmd('Start or Stop Dictation', 'dictate', 'CmdOrCtrl+Shift+Space')
      ]
    },
    {
      label: 'View',
      submenu: [
        cmd('Quick Actions', 'quick', 'CmdOrCtrl+K'),
        cmd('Inbox', 'inbox', 'CmdOrCtrl+I'),
        cmd('Broadcast', 'broadcast', 'CmdOrCtrl+B'),
        cmd('Find in Project', 'find', 'CmdOrCtrl+Shift+F'),
        { type: 'separator' },
        cmd('Maximize Pane', 'maximize', 'CmdOrCtrl+Enter'),
        cmd('Next Pane', 'next-pane', 'CmdOrCtrl+]'),
        cmd('Previous Pane', 'previous-pane', 'CmdOrCtrl+['),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
