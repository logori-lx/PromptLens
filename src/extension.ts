import * as vscode from 'vscode';
import { spawn } from 'child_process'; 
import * as path from 'path';         

// For test, if env development is set, redundant debug log will be printed
const isDev = process.env.NODE_ENV === 'development';
const TRIGGER_MARK = '//>';
const DEBOUNCE_DELAY = 800; // 0.8s debounce
const PROMTLENS_ENGINE = "promptlens_engine";

const loadingDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        contentText: ' Calling AI engine to generate code...',
        // Use the same ghost gray color as Ghost Text
        color: new vscode.ThemeColor('editorGhostText.foreground'), 
        fontStyle: 'italic'
    }
});

// The data structure which will be passed to rust core engine 
interface AIPayload {
    user_prompt: string;
    file_content: string;
    language_id: string;
}
// The data structure which will be returned by core engine
interface RustEngineOutput {
    user_prompt: string;
    context_skeleton: string[];
    error: string | null;
}

// Helper function: Achieves perfect debouncing combined with CancellationToken
const delay = (ms: number, token: vscode.CancellationToken) => {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            if (token.isCancellationRequested) {
                reject(new Error('Cancelled'));
            } else {
                resolve();
            }
        }, ms);

        // If VS Code reports the request is cancelled during the wait (user typed again)
        token.onCancellationRequested(() => {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
        });
    });
};

export function activate(context: vscode.ExtensionContext) {
    console.log('PromptLens extension activated! Using official Ghost Text architecture');

    // 1. Shortcut command to insert trigger mark
    let insertMarkCmd = vscode.commands.registerCommand('promptlens.insertPromptMark', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const position = editor.selection.active;
            editor.edit(editBuilder => {
                editBuilder.insert(position, `${TRIGGER_MARK} `);
            });
        }
    });

    // Core feature: Register Ghost Text provider (handles debouncing and AI requests here)
    const provider: vscode.InlineCompletionItemProvider = {
        // Step 1: VS Code automatically calls this function on every keystroke, passing a CancellationToken
        async provideInlineCompletionItems(document, position, _context, token) {
            
            const lineText = document.lineAt(position.line).text;
            const textBeforeCursor = lineText.substring(0, position.character);
            const markIndex = textBeforeCursor.indexOf(TRIGGER_MARK);
            
            if (markIndex !== -1) {
                const promptText = textBeforeCursor.substring(markIndex + TRIGGER_MARK.length).trim();

                if (promptText.length > 0) {
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) return [];

                    try {

                        // Debounce mechanism, wait for DEBOUNCE_DELAY millseconds before get user's prompt
                        await delay(DEBOUNCE_DELAY, token);
                        const fullCode = document.getText(); // Get all code in the current file
                        const currentLanguage = document.languageId; // Get the language ID of the current file
                        const inputPayload: AIPayload = {
                            user_prompt: promptText,
                            file_content: fullCode,
                            language_id: currentLanguage 
                        };

                        // Trigger loading animation at cursor after user stops typing for 0.8 seconds
                        const decorationRange = new vscode.Range(position, position);
                        editor.setDecorations(loadingDecorationType, [decorationRange]);


                        // Show status bar animation and request AI
                        const items = await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Window,
                            title: `PromptLens: Generating code...`,
                        }, async (progress) => {
                            
                            let aiResponse: string;
                            if (isDev){
                                aiResponse = await callMockAI(inputPayload, token, context);
                            }else{
                                aiResponse = await callAI(inputPayload, token, context);
                            }

    
                            // 4. Clear loading decoration at cursor immediately after AI responds
                            editor.setDecorations(loadingDecorationType, []);

                            // Discard the result if the user types again during the AI network request
                            if (token.isCancellationRequested) {
                                return [];
                            }

    
                            // 5. Return InlineCompletionItem (The actual Ghost Text)
                            const item = new vscode.InlineCompletionItem(
                                aiResponse,
                                new vscode.Range(position, position)
                            );

                            return [item];
                        });
                        
                        return items;

                    } catch (e) {

                        // Remember to clear the loading decoration if debouncing is cancelled (user typed again)
                        if (editor) editor.setDecorations(loadingDecorationType, []);
                        return [];
                    }
                }
            }
            return [];
        }
    };

    // Register the provider
    let inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' }, 
        provider
    );

    context.subscriptions.push(insertMarkCmd, inlineProvider);
}
// the extension will create a child process to run rust core engine
async function runRustEngine(payload: AIPayload, context: vscode.ExtensionContext, token: vscode.CancellationToken): Promise<RustEngineOutput> {
    return new Promise((resolve, reject) => {
        // the rust engine executable file need to be placed in 
        // Windows: ${extensionPath}/bin/promptlens-engine.exe
        // Linux:   ${extensionPath}/bin/promptlens-engine
        const isWindows = process.platform === 'win32';
        const engineExecutable = isWindows ? `${PROMTLENS_ENGINE}.exe` : PROMTLENS_ENGINE;;
        const enginePath = path.join(context.extensionPath, 'bin', engineExecutable);

        const child = spawn(enginePath);
        
        let stdoutData = '';
        let stderrData = '';
        // to catch the error generated by file not existed or user doesn't have execution access for the file
        child.on('error', (err) => {
            reject(new Error(`Failed to start Rust engine: ${err.message}`));
        });

        child.stdout.on('data', (data) => { stdoutData += data.toString(); });
        child.stderr.on('data', (data) => { stderrData += data.toString(); });

        child.on('close', (code) => {
            if (token.isCancellationRequested) {
                reject(new Error('Cancelled'));
                return;
            }

            if (code !== 0) {
                console.error(`Rust engine error: ${stderrData}`);
                reject(new Error(`Rust Engine Exited with code ${code}`));
            } else {
                try {
                    const result = JSON.parse(stdoutData) as RustEngineOutput;
                    resolve(result);
                } catch (e) {
                    reject(new Error("Invalid JSON from Rust Engine"));
                }
            }
        });

        

        // 用户继续打字时，终止无用的 Rust 解析进程
        token.onCancellationRequested(() => {
            child.kill();
            reject(new Error('Cancelled'));
        });

        // 将当前文件的 payload 发送给 Rust 的 stdin
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}
// Convert object to formatted JSON string (2-space indent for readability)

// For test, mock AI behavior
async function callMockAI(payload: AIPayload, token: vscode.CancellationToken, context: vscode.ExtensionContext): Promise<string> {
    // print payload that will be passed to rust engine
    const payloadJsonString = JSON.stringify(payload, null, 2);
    console.log("JSON data ready to be passed to Rust:\n", payloadJsonString);
    console.log("Starting Rust AST Engine...");

    // use rust core engine to analyze AST tree
    const rustResult = await runRustEngine(payload, context, token);
    const rustResultJsonString = JSON.stringify(rustResult, null, 2);
    console.log("JSON data received from Rust:\n", rustResultJsonString);

    if (rustResult.error) {
        console.error("Rust Engine Error:", rustResult.error);
    }

    // the output of rustcore engine which will be passed to LLM
    const aiRequestPayload = {
        prompt: rustResult.user_prompt,
        context_skeleton: rustResult.context_skeleton.join('\n')
    };
    console.log("Final JSON prepared for LLM API:\n", JSON.stringify(aiRequestPayload, null, 2));
    
    // Simulate network latency (1.5 seconds)
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (token.isCancellationRequested) reject(new Error('Cancelled'));
            else resolve();
        }, 1500);
        
        token.onCancellationRequested(() => {
            clearTimeout(timeout);
            reject(new Error('Cancelled'));
        });
    });
    
    if (token.isCancellationRequested) throw new Error('Cancelled');
    
    const prompt = payload.user_prompt;
    let aiResponse = '';
    
    if (prompt.toLowerCase().includes('函数') || prompt.toLowerCase().includes('function')) {
        aiResponse = `\n// AI generated function based on "${prompt}"\nfunction aiGeneratedFunction() {\n    console.log("Execution successful");\n    return true;\n}`;
    } else if (prompt.toLowerCase().includes('类') || prompt.toLowerCase().includes('class')) {
        aiResponse = `\n// AI generated class based on "${prompt}"\nclass AIGeneratedClass {\n    constructor() {\n        this.value = "AI Generated";\n    }\n}`;
    } else if (prompt.toLowerCase().includes('循环') || prompt.toLowerCase().includes('loop')) {
        aiResponse = `\n// AI generated loop based on "${prompt}"\nfor (let i = 0; i < 10; i++) {\n    console.log(\`Iteration: \${i}\`);\n}`;
    } else {
        aiResponse = `\n// AI generated code based on "${prompt}"\nconst result = "AI generated code block";\nconsole.log(result);`;
    }
    
    return aiResponse;
}

// TBD, enter the prompt & AST tree text and get the aioutput.
async function callAI(payload: AIPayload, token: vscode.CancellationToken, context: vscode.ExtensionContext): Promise<string> {
    try {
        console.log("Starting Rust AST Engine...");
        // use rust core engine to analyze AST tree
        const rustResult = await runRustEngine(payload, context, token);

        if (rustResult.error) {
            console.error("Rust Engine Error:", rustResult.error);
        }

        // the output of rustcore engine which will be passed to LLM
        const aiRequestPayload = {
            prompt: rustResult.user_prompt,
            context_skeleton: rustResult.context_skeleton.join('\n')
        };

        console.log("Final JSON prepared for LLM API:\n", JSON.stringify(aiRequestPayload, null, 2));

        
        
    } catch (error) {
        if (error instanceof Error && error.message === 'Cancelled') {
            throw error;
        }
        console.error("Error in callAI:", error);
        return "";
    }
}
export function deactivate() {}