use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(untagged)]
pub(crate) enum LanguageID {
    // Attempt to match known languages first.
    Known(KnownLanguage),
    // If matching fails, store the unsupported language ID as a string here.
    Unsupported(String),
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
pub(crate) enum KnownLanguage {
    #[serde(rename = "c")] C,
    #[serde(rename = "cpp")] Cpp,
    #[serde(rename = "csharp")] CSharp,
    #[serde(rename = "rust")] Rust,
    #[serde(rename = "python")] Python,
    #[serde(rename = "java")] Java,
    #[serde(rename = "go")] Go,
    #[serde(rename = "javascript")] JavaScript,
    #[serde(rename = "javascriptreact")] JavaScriptReact, // JSX
    #[serde(rename = "typescript")] TypeScript,
    #[serde(rename = "typescriptreact")] TypeScriptReact, // TSX
    #[serde(rename = "html")] Html,
    #[serde(rename = "css")] Css,
    #[serde(rename = "scss")] Scss,
    #[serde(rename = "less")] Less,
    #[serde(rename = "json")] Json,
    #[serde(rename = "jsonc")] JsonWithComments,
    #[serde(rename = "jsonl")] JsonLines,
    #[serde(rename = "yaml")] Yaml,
    #[serde(rename = "xml")] Xml,
    #[serde(rename = "markdown")] Markdown,
    #[serde(rename = "shellscript")] ShellScript,
    #[serde(rename = "bat")] Batch,
    #[serde(rename = "powershell")] PowerShell,
    #[serde(rename = "sql")] Sql,
    #[serde(rename = "php")] Php,
    #[serde(rename = "ruby")] Ruby,
    #[serde(rename = "swift")] Swift,
    #[serde(rename = "objective-c")] ObjectiveC,
    #[serde(rename = "objective-cpp")] ObjectiveCpp,
    #[serde(rename = "dart")] Dart,
    #[serde(rename = "lua")] Lua,
    #[serde(rename = "perl")] Perl,
    #[serde(rename = "r")] R,
    #[serde(rename = "julia")] Julia,
    #[serde(rename = "clojure")] Clojure,
    #[serde(rename = "fsharp")] FSharp,
    #[serde(rename = "groovy")] Groovy,
    #[serde(rename = "makefile")] Makefile,
    #[serde(rename = "dockerfile")] Dockerfile,
    #[serde(rename = "dockercompose")] Compose,
    #[serde(rename = "ignore")] Ignore,
    #[serde(rename = "properties")] Properties,
    #[serde(rename = "ini")] Ini,
    #[serde(rename = "dotenv")] Dotenv,
    #[serde(rename = "diff")] Diff,
    #[serde(rename = "git-commit")] GitCommit,
    #[serde(rename = "git-rebase")] GitRebase,
    #[serde(rename = "plaintext")] PlainText,
}