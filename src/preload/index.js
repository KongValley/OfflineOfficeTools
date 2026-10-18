const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  openFiles: (opts) => ipcRenderer.invoke('dialog:openFiles', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('file:write', filePath, data),
  writeUnique: (dir, name, data) => ipcRenderer.invoke('file:writeUnique', dir, name, data),
  fileSize: (filePath) => ipcRenderer.invoke('file:size', filePath),
  htmlToPdf: (html, targetPath) => ipcRenderer.invoke('md:toPdf', html, targetPath),
  decodeText: (data, encoding) => ipcRenderer.invoke('text:decode', data, encoding),
  encodeText: (text, encoding) => ipcRenderer.invoke('text:encode', text, encoding),
  loadCjkFont: () => ipcRenderer.invoke('font:loadCjk'),
  loadTodos: () => ipcRenderer.invoke('todo:load'),
  saveTodos: (list) => ipcRenderer.invoke('todo:save', list),
  processImageFile: (filePath, op) => ipcRenderer.invoke('image:processFile', filePath, op),
  previewImage: (filePath) => ipcRenderer.invoke('image:previewFile', filePath),
  embeddedJpeg: (data, opts) => ipcRenderer.invoke('image:embeddedJpeg', data, opts),
  isOpaque: (data, opts) => ipcRenderer.invoke('image:isOpaque', data, opts)
})
