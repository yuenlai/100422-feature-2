// tsc 只解析 @/ 别名、不改写产物里的路径，这里把 @/ 映射到编译输出目录。
const Module = require('module')
const path = require('path')
const outSrc = path.join(__dirname, '..', 'node_modules', '.cache', 'verify', 'src')
const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith('@/')) {
    request = path.join(outSrc, request.slice(2))
  }
  return orig.call(this, request, ...args)
}
