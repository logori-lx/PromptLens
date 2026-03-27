# PromptLens: AST-Based AI Code Provenance & Evolution Tracker

**PromptLens** is a high-performance vscode extension designed to bridge the gap between AI-generated code prompts and long-term code evolution. By leveraging a Rust-powered core engine, it creates a "Semantic Fingerprint" for AI-generated snippets, ensuring that the original intent (Prompt) remains traceable even as the codebase undergoes refactoring and evolution.

---

## Key Features

* **Intelligent Intent Binding**: Automatically inserts prompt markers (e.g., `//>`) and captures developer input to generate code via LLM.
* **Seamless UI/UX**: Implements "Ghost Text" previews (similar to Copilot); code is only committed to the file when the user presses `Tab`.
* **Rust-Powered AST Engine**: Once accepted, a Rust-based core engine parses the code into an Abstract Syntax Tree (AST) for deep analysis.
* **Dual-Verification Tracking(WIP)**:
    * **Exact Anchor**: Uses SHA256 hashing for instant 100% match verification.
    * **Fuzzy Semantic Matching**: Employs the Jaccard Similarity algorithm on semantic tokens to track code even after significant refactoring.
* **Automated Git Integration(TODO)**: A pre-commit hook analyzes changes and utilizes LLMs to generate summarized commit messages based on prompts and diffs.
* **IDE Provenance Overlay(TODO)**: Real-time hover display in the IDE showing the original prompt associated with specific functions.

