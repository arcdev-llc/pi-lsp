export default {
    lib: [
        { format: 'esm', syntax: "es2022", dts: true },
    ],
    source: {
        entry: {
            "lsp": "./src/lsp.ts",
            "lsp-tool": "./src/lsp-tool.ts"
        }
    },
    output: {
        target: "node",
        distPath: "./dist",
    }
}
