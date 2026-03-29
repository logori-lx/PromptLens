use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use tree_sitter::{Node, Parser};
mod language_support;
use language_support::language::LanguageID;
use language_support::language::KnownLanguage;
const DEBUG_JSON_PATH: &str = "test_input.json";
const ACTIVE_NODE_THRESHOLD: usize =  150;

// The structure of data received from Node.js
#[derive(Deserialize, Debug)]
struct InputPayload {
    user_prompt: String,
    file_content: String,
    language_id: LanguageID, 
}

// The structure of data output to Node.js
#[derive(Serialize, Debug)]
struct OutputPayload {
    user_prompt: String,
    context_skeleton: Vec<String>,
    error: Option<String>,
}



// Recursively traverse the AST, extract the skeletons or error fragments of function.
// TODO: consider if the extract_functions need to be exposed to public as input variable signatures is useless for user.
fn extract_functions(node: Node, code_bytes: &[u8], trigger_idx: Option<usize>, signatures: &mut Vec<String>) {
    let kind = node.kind();
    let start_byte = node.start_byte();
    let end_byte = node.end_byte();
    // Determine if the node is close to the prompt.
    // If so, set this node as an active node. 
    // An active node will be stored entirely without any simplification.
    let is_active_node = if let Some(idx) = trigger_idx {
        
        (idx >= start_byte && idx <= end_byte) // if the prompt is located in the function(start < idx < end)
        || (start_byte > idx && start_byte - idx < ACTIVE_NODE_THRESHOLD) // if the prompt is located outside but close to the function
    } else {
        false
    };
    // If the node can't be analyzed, then add a tag and store the whole function 
    if node.is_error() {
        if let Ok(snippet) = std::str::from_utf8(&code_bytes[start_byte..end_byte]) {
            let clean_snippet = snippet.trim();
            if clean_snippet.len() > 3 {
                signatures.push(format!("// [Editing block or code block with grammar error]\n{}", clean_snippet));
            }
        }
    } 
    else if kind == "function_definition"    // function in C/C++
        || kind == "function_item"      // function in Rust
        || kind == "method_definition"  // function definition
        || kind == "class_specifier"    // class in C++
    {
        if let Ok(snippet) = std::str::from_utf8(&code_bytes[start_byte..end_byte]) {
            if is_active_node {
                // Addd a tag and store to mark this code is editing and store the whole function. 
                signatures.push(format!("// [Editing block]\n{}", snippet.trim()));
                return;
            } else {
                // For function isn't related to the editing block, 
                // trim the function body to reduce redundant info. 
                if let Some(first_line) = snippet.lines().next() {
                    // trim all  the '{', ' ', '\r', '\n' in the tail.
                    // TODO: use other method to trim the redundant punctuation not just '{', ' ', '\r', '\n' 
                    let clean_signature = first_line
                        .trim_end_matches(|c| c == '{' || c == ' ' || c == '\r' || c == '\n')
                        .trim()
                        .to_string();
                        
                    // Add a ';' as it may be useful for AI analyzing in C/C++ & rust
                    signatures.push(format!("{};", clean_signature)); 
                }
            }
        }
    }

    // Recursively traverse all the node
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        extract_functions(child, code_bytes, trigger_idx, signatures);
    }
}
fn main() {
    let input_json: String;

    // In debug mode, engine will read the input from file DEBUG_JSON_PATH instead of frontend.
    if cfg!(debug_assertions) {
        // To prevent debug log being treated as valid input by frontend, print debug msg to stderr
        eprintln!("[Debug Mode] Reading from local test file: {}", DEBUG_JSON_PATH);
        input_json = fs::read_to_string(DEBUG_JSON_PATH)
            .unwrap_or_else(|_| panic!("[Debug Mode] Test file {} not exist!", DEBUG_JSON_PATH));
    // In production mode, engine will read the input from typescript frontend.
    } else {
        let mut buffer = String::new();
        if let Err(e) = io::stdin().read_to_string(&mut buffer) {
            eprintln!("Failed to read stdin: {}", e);
            std::process::exit(1);
        }
        input_json = buffer;
    }

    // Analyze the input json file.
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

    // Initialize Tree-sitter Parser
    let mut parser = Parser::new();

    // Identify the language based on the language_id received from VS Code.
    let language: tree_sitter::Language = match &input.language_id {
        // Handle languages for which we have already imported a Parser.
        LanguageID::Known(KnownLanguage::C) | LanguageID::Known(KnownLanguage::Cpp) => tree_sitter_cpp::LANGUAGE.into(),
        LanguageID::Known(KnownLanguage::Rust) => tree_sitter_rust::LANGUAGE.into(),
        
        // Handle completely unknown strings.
        LanguageID::Unsupported(unknown_lang) => {
            output.error = Some(format!("Unknown language: {}", unknown_lang));
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            return;
        }

        // Catch other known languages defined in the enum but lacking an imported parser.
        // TODO: consider if the output need to be print in production mode
        LanguageID::Known(known_but_unsupported) => {
            output.error = Some(format!("Language {:?} Not Support", known_but_unsupported));
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            return;
        }
    };

    if let Err(e) = parser.set_language(&language) {
        output.error = Some(format!("Failed to load the language parser: {}", e));
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
        return;
    }

    // Analyze the source code to create Ast tree.
    let code_bytes = input.file_content.as_bytes();

    let trigger_idx = input.file_content.find("//>");
    if let Some(tree) = parser.parse(code_bytes, None) {
        // analyze the root node.
        extract_functions(tree.root_node(), code_bytes, trigger_idx, &mut output.context_skeleton);
        
        // Fault tolerance fallback mechanism, if nothing can be analyzed from the code
        // use the original code instead.
        if output.context_skeleton.is_empty() {
            let fallback_snippet = input.file_content.lines().take(50).collect::<Vec<_>>().join("\n");
            output.context_skeleton.push(format!("// [Code contains severe syntax errors or lacks function structure, falling back to raw code]\n{}", fallback_snippet));
        }
        
    } else {
        // Extreme case where Tree-sitter completely crashes or fails to parse.
        let fallback_snippet = input.file_content.lines().take(50).collect::<Vec<_>>().join("\n");
        output.context_skeleton.push(format!("// [AST parsing completely failed, falling back to raw code]\n{}", fallback_snippet));
    }

    // Output the final result.
    if cfg!(debug_assertions) {
        // In debug mode, print formatted JSON for readability.
        println!("\nAnalyze result:");
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
    } else {
        // In production mode, print as a single compact line for Node.js to read.
        println!("{}", serde_json::to_string(&output).unwrap());
    }
}