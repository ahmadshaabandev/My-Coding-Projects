// Module shapes produced by the wrangler.toml `rules` (CompiledWasm / Data).
declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
declare module '*.woff' {
  const data: ArrayBuffer
  export default data
}
declare module '*.ttf' {
  const data: ArrayBuffer
  export default data
}
