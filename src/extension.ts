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

    // register a command to delete the //> ${prompt}
    // markindex: the index of "//>"
    // line: the line number of the prompt
    let cleanupCmd = vscode.commands.registerCommand('promptlens.cleanupPrompt', (line: number, markIndex: number) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.edit(editBuilder => {
                // Start of deletion: The beginning of the prompt (the position of '//>')
                const startPos = new vscode.Position(line, markIndex);
                // End of deletion: The beginning of the next line (this removes the original prompt along with the '\n' we forcedly added for the preview)
                const endPos = new vscode.Position(line + 1, 0);
                
                editBuilder.delete(new vscode.Range(startPos, endPos));
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

                            // [Core Magic: Bypassing VS Code's strict prefix validation]
                            // VS Code natively requires that if a replacement range is specified, the AI-generated 
                            // code must start with the exact text within that range. Otherwise, it silently drops the Ghost Text.
                            // Since we force the AI to return pure code starting with a newline (\n), it will 
                            // never match the preceding `//> prompt` text.
                            // Solution: Set the Range to a 0-length cursor position (position, position).
                            // This tells VS Code: "Do not replace any text; simply insert the preview at the cursor."
                            // This allows the Ghost Text to render successfully. The leftover prompt will be 
                            // automatically cleaned up when the user presses Tab, triggered by the command attached below.
                            const replaceRange = new vscode.Range(position, position);
                            
                            // Return InlineCompletionItem (The actual Ghost Text)
                            const item = new vscode.InlineCompletionItem(
                                aiResponse,
                                replaceRange
                            );

                            // mount the cleanup command registered before,
                            // After user press Tab, the cleanup command will be executed to delete the "//> ${prompt}"
                            item.command = {
                                title: 'Cleanup Prompt',
                                command: 'promptlens.cleanupPrompt',
                                arguments: [position.line, markIndex] // 传入当前行号和提示词起点的索引
                            };

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

    // to declare that the three command insertMarkCmd, inlineProvider, cleanupCmd is unique cmd to this extension
    // if the extension has been uninstalled or disabled, this three commands also need to be deleted automatically.
    context.subscriptions.push(insertMarkCmd, inlineProvider, cleanupCmd);
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

        

        // When user continue to type words, stop running useless process.
        token.onCancellationRequested(() => {
            child.kill();
            reject(new Error('Cancelled'));
        });

        // send the analyzed file payload to the stdin of rust payload. 
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
        
        const config = vscode.workspace.getConfiguration('promptlens');
        const API_KEY = config.get<string>('apiKey');
        const API_BASE_URL = config.get<string>('baseUrl');
        const MODEL_NAME = config.get<string>('model');
        console.log("API_BASE_URL:", API_BASE_URL, "API_KEY", API_KEY, "MODEL_NAME", MODEL_NAME);
        // To ensure the necessary message for llm existed
        if (!API_KEY || !API_BASE_URL || !MODEL_NAME) {
            vscode.window.showErrorMessage("PromptLens: 请先在 VS Code 设置中完善 API Key, Base URL 和 Model Name！");
            return "";
        }
        

        // AbortController is set to cancel the network request when the user typing.
        const controller = new AbortController();
        const signal = controller.signal;
        
        // When vs code send cancel signal, stop fetch request.
        token.onCancellationRequested(() => {
            controller.abort();
        });

        // Construct request body
        const requestBody = {
            model: "deepseek-coder",
            messages: [
                {
                    role: "system",
                    content: `You are an AI engine specialized in IDE Inline Code Completion (Ghost Text).
Your task is to strictly generate ONLY the "new code to be inserted at the cursor position" based on the user's prompt.

[STRICT RULES]:
1. The provided 'Context Skeleton' is ONLY for you to understand the current file's environment (e.g., variables, function signatures). You are ABSOLUTELY FORBIDDEN from including, repeating, or completing any code from the Context Skeleton in your output!
2. DO NOT include any markdown formatting (e.g., \`\`\`cpp or \`\`\`).
3. DO NOT include any explanations, greetings, comments, or conversational text.
4. Your output will be directly inserted into the user's text editor. Ensure you output PURE, raw code only.
5. CRITICAL: You MUST start your generated response with a newline character (\\n). The code you generate must begin on a new line below the user's prompt.`
                },
                {
                    role: "user",
                    content: `[Reference Context Skeleton] (For reference ONLY. DO NOT output any of this):
${aiRequestPayload.context_skeleton}

[User's Prompt] (Generate ONLY the code requested here):
${aiRequestPayload.prompt}`
                }
            ],
            temperature: 0.1, // Keep the temperature low to ensure more deterministic and consistent code generation.
            max_tokens: 1024
        };

        // send request to llm
        const response = await fetch(API_BASE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify(requestBody),
            signal: signal as any // bind the cancel signal.
        });

        if (!response.ok) {
            throw new Error(`DeepSeek API 請求失敗: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json() as any;
        console.log("The response of LLM API:\n", JSON.stringify(data, null, 2));
        // analyze the code returned by llm.
        if (data.choices && data.choices.length > 0) {
            // Use .trim() to ensure all leading and trailing whitespaces are completely removed
            let generatedCode = data.choices[0].message.content.trim();
            
            // Fault tolerance: Some LLMs stubbornly include markdown tags (e.g., ```cpp ... ```) even when warned not to.
            // Apply a simple regex filter here to ensure the Ghost Text renders cleanly.
            generatedCode = generatedCode.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '');
            // if generated code doesn't start with a \n
            // add it manually
            if (!generatedCode.startsWith('\n')) {
                generatedCode = '\n' + generatedCode;
            }
            return generatedCode;
        }

        return "";
        
        
    } catch (error) {
        if (error instanceof Error && error.message === 'Cancelled') {
            throw error;
        }
        console.error("Error in callAI:", error);
        return "";
    }
}
export function deactivate() {}

