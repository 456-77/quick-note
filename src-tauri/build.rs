fn main() {
    // 前端产物（dist/）被 tauri 以 include_bytes 方式嵌进二进制；
    // 不声明 rerun-if-changed 的话，Rust 源码没变时 cargo 会跳过重编，
    // exe 里永远嵌着**旧前端**——改了 TS 却"怎么跑都不生效"就是这条造成的。
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}
