use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use tree_sitter::{Node, Parser};

// ==========================================
// 🛠️ 開發與測試配置
// ==========================================
// 將此開關設為 true 時，程序會直接讀取本地的 test_input.json 進行解析測試
const IS_DEBUG_MODE: bool = true;
const DEBUG_JSON_PATH: &str = "test_input.json";

// 1. 定義從 Node.js (或本地測試文件) 接收的輸入結構
#[derive(Deserialize, Debug)]
struct InputPayload {
    user_prompt: String,
    file_content: String,
    file_extension: String,
}

// 2. 定義發還給前端的輸出結構
#[derive(Serialize, Debug)]
struct OutputPayload {
    user_prompt: String,
    context_skeleton: Vec<String>,
    error: Option<String>,
}

// 3. 核心邏輯：遞歸遍歷 AST，提取函數骨架與錯誤（半成品）片段
fn extract_functions(node: Node, code_bytes: &[u8], trigger_idx: Option<usize>, signatures: &mut Vec<String>) {
    let kind = node.kind();
    let start_byte = node.start_byte();
    let end_byte = node.end_byte();

    // 🌟 核心增强：计算当前节点是否离用户的 Prompt 非常近
    let is_active_node = if let Some(idx) = trigger_idx {
        // 情况1：prompt 就在这个函数内部 (idx 在 start 和 end 之间)
        // 情况2：prompt 在函数上方紧挨着（函数 start 距离 prompt 不超过 150 个字节）
        (idx >= start_byte && idx <= end_byte) || (start_byte > idx && start_byte - idx < 150)
    } else {
        false
    };

    if node.is_error() {
        if let Ok(snippet) = std::str::from_utf8(&code_bytes[start_byte..end_byte]) {
            let clean_snippet = snippet.trim();
            if clean_snippet.len() > 3 {
                signatures.push(format!("// [当前正在编写或存在语法的代码块]\n{}", clean_snippet));
            }
        }
    } 
    else if kind == "function_definition"    // C/C++ 等的函数
        || kind == "function_item"      // Rust 的函数
        || kind == "method_definition"  // 类的方法
        || kind == "class_specifier"    // C++ 的类
    {
        if let Ok(snippet) = std::str::from_utf8(&code_bytes[start_byte..end_byte]) {
            if is_active_node {
                // [当前正在编辑的完整代码块] 逻辑不变
                signatures.push(format!("// [当前正在编辑的完整代码块]\n{}", snippet.trim()));
                return;
            } else {
                // 🌟 【增强的清理逻辑】：更强悍的尾部裁剪
                if let Some(first_line) = snippet.lines().next() {
                    // 使用闭包过滤掉尾部所有的 '{', ' ', '\r', '\n'
                    let clean_signature = first_line
                        .trim_end_matches(|c| c == '{' || c == ' ' || c == '\r' || c == '\n')
                        .trim()
                        .to_string();
                        
                    // 加上分号，让它看起来是一个完美的函数声明 (可选，但对 C++/Rust 的 AI 理解有帮助)
                    signatures.push(format!("{};", clean_signature)); 
                }
            }
        }
    }

    // 递归遍历所有子节点（注意要把 trigger_idx 传下去）
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_functions(child, code_bytes, trigger_idx, signatures);
    }
}
fn main() {
    let input_json: String;

    // ==========================================
    // 🚀 數據獲取：區分測試環境與生產環境
    // ==========================================
    if IS_DEBUG_MODE {
        // 測試模式：直接從本地讀取 JSON 檔案
        println!("🛠️ [測試模式] 正在讀取本地文件: {}", DEBUG_JSON_PATH);
        input_json = fs::read_to_string(DEBUG_JSON_PATH)
            .unwrap_or_else(|_| panic!("❌ 找不到測試文件 {}，請在 Rust 專案根目錄創建它！", DEBUG_JSON_PATH));
    } else {
        // 生產模式：從標準輸入讀取 VS Code 傳來的數據
        let mut buffer = String::new();
        if let Err(e) = io::stdin().read_to_string(&mut buffer) {
            eprintln!("Failed to read stdin: {}", e);
            std::process::exit(1);
        }
        input_json = buffer;
    }

    // 解析 JSON
    let input: InputPayload = match serde_json::from_str(&input_json) {
        Ok(data) => data,
        Err(e) => {
            let err_out = OutputPayload {
                user_prompt: String::new(),
                context_skeleton: vec![],
                error: Some(format!("JSON 解析失敗: {}", e)),
            };
            println!("{}", serde_json::to_string_pretty(&err_out).unwrap());
            return;
        }
    };

    let mut output = OutputPayload {
        user_prompt: input.user_prompt.clone(),
        context_skeleton: Vec::new(),
        error: None,
    };

    // 初始化 Tree-sitter Parser
    let mut parser = Parser::new();

    // 根據前端傳來的後綴名，動態加載對應的語言引擎
    let language: tree_sitter::Language = match input.file_extension.as_str() {
        "cpp" | "c" | "h" | "hpp" => tree_sitter_cpp::LANGUAGE.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        ext => {
            output.error = Some(format!("目前尚未配置对 .{} 文件的解析支持", ext));
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            return;
        }
    };

    if let Err(e) = parser.set_language(&language) {
        output.error = Some(format!("加載語言解析器失敗: {}", e));
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
        return;
    }

    // 解析源碼生成 AST
    let code_bytes = input.file_content.as_bytes();

    let trigger_idx = input.file_content.find("//>");
    if let Some(tree) = parser.parse(code_bytes, None) {
        // 传入 trigger_idx
        extract_functions(tree.root_node(), code_bytes, trigger_idx, &mut output.context_skeleton);
        
        // 🛡️ 容错降级机制 (Fallback)
        if output.context_skeleton.is_empty() {
            let fallback_snippet = input.file_content.lines().take(50).collect::<Vec<_>>().join("\n");
            output.context_skeleton.push(format!("// [代码包含严重语法错误或无函数结构，采用原始代码 Fallback]\n{}", fallback_snippet));
        }
        
    } else {
        // Tree-sitter 徹底宕機的極限情況
        let fallback_snippet = input.file_content.lines().take(50).collect::<Vec<_>>().join("\n");
        output.context_skeleton.push(format!("// [AST 解析徹底失敗，採用原始代碼 Fallback]\n{}", fallback_snippet));
    }

    // 輸出最終結果
    if IS_DEBUG_MODE {
        // 測試模式下，為了方便肉眼看，我們打印格式化後的 JSON (to_string_pretty)
        println!("\nAnalyze result:");
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        // 生產模式下，壓縮成一行打印給 Node.js 讀取
        println!("{}", serde_json::to_string(&output).unwrap());
    }
}