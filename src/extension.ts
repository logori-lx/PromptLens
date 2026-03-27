import * as vscode from 'vscode';

// for test, if env development is set, redudant debug log will be printed
const isDev = process.env.NODE_ENV === 'development';
const TRIGGER_MARK = '//>';
const DEBOUNCE_DELAY = 800; // 0.8秒防抖

const loadingDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        contentText: ' ⏳ 正在呼叫 AI 引擎生成代碼...',
        // 使用跟 Ghost Text 一样的幽灵灰色
        color: new vscode.ThemeColor('editorGhostText.foreground'), 
        fontStyle: 'italic'
    }
});
// 🛠️ 辅助函数：结合 CancellationToken 实现完美的防抖
const delay = (ms: number, token: vscode.CancellationToken) => {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            if (token.isCancellationRequested) {
                reject(new Error('Cancelled'));
            } else {
                resolve();
            }
        }, ms);

        // 如果在等待期间，VS Code 报告请求已取消（用户又敲了键盘）
        token.onCancellationRequested(() => {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
        });
    });
};

export function activate(context: vscode.ExtensionContext) {
    console.log('🔧 PromptLens 扩展已激活！使用官方 Ghost Text 架构');

    // 1. 快捷鍵插入標記功能
    let insertMarkCmd = vscode.commands.registerCommand('promptlens.insertPromptMark', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const position = editor.selection.active;
            editor.edit(editBuilder => {
                editBuilder.insert(position, `${TRIGGER_MARK} `);
            });
        }
    });

    // 2. 核心功能：注册 Ghost Text 提供者 (在这里处理防抖和AI请求)
    const provider: vscode.InlineCompletionItemProvider = {
        // VS Code 会在用户每次敲击键盘时自动调用这个函数，并传入一个 CancellationToken
        async provideInlineCompletionItems(document, position, context, token) {
            
            const lineText = document.lineAt(position.line).text;
            const textBeforeCursor = lineText.substring(0, position.character);
            const markIndex = textBeforeCursor.indexOf(TRIGGER_MARK);
            
            if (markIndex !== -1) {
                const promptText = textBeforeCursor.substring(markIndex + TRIGGER_MARK.length).trim();

                if (promptText.length > 0) {
                    const editor = vscode.window.activeTextEditor;
                    if (!editor) return [];
                    // print the code that frontend get.
                    if(isDev){
                        const fullCode = document.getText(); // 获取当前文件的所有代码

                        const currentLanguage = document.languageId; //获取当前文件的语言名称
                        
                        const inputPayload = {
                            user_prompt: promptText,
                            file_content: fullCode,
                            language_id: currentLanguage 
                        };
                        // 将对象转为格式化的 JSON 字符串（缩进2个空格，方便阅读）
                        const jsonString = JSON.stringify(inputPayload, null, 2);
                        
                        // 打印到调试控制台
                        console.log("📦 准备传给 Rust 的 JSON 数据如下:\n", jsonString);
                    }
                   

                    try {
                        // ==========================================
                        // ⏱️ 1. 防抖机制
                        // ==========================================
                        await delay(DEBOUNCE_DELAY, token);

                        // ==========================================
                        // ⚡ 2. 用户停止输入 0.8 秒后，触发游标处的 Loading 动画
                        // ==========================================
                        const decorationRange = new vscode.Range(position, position);
                        editor.setDecorations(loadingDecorationType, [decorationRange]);

                        // ==========================================
                        // ⏳ 3. 显示状态栏动画，并请求 AI
                        // ==========================================
                        const items = await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Window,
                            title: `🤖 PromptLens: 正在生成代码...`,
                        }, async (progress) => {
                            
                            let aiResponse: string;
                            if (isDev){
                                aiResponse = await callMockAI(promptText, token);
                            }else{
                                aiResponse = await callAI(promptText, token);
                            }

                            // ==========================================
                            // 🧹 4. AI 响应回来后，立刻清除游标处的 Loading 装饰
                            // ==========================================
                            editor.setDecorations(loadingDecorationType, []);

                            // 如果在 AI 网络请求期间，用户又打字了，直接丢弃结果
                            if (token.isCancellationRequested) {
                                return [];
                            }

                            // ==========================================
                            // ✨ 5. 返回 InlineCompletionItem (真正的 Ghost Text)
                            // ==========================================
                            const item = new vscode.InlineCompletionItem(
                                aiResponse,
                                new vscode.Range(position, position)
                            );

                            return [item];
                        });
                        
                        return items;

                    } catch (e) {
                        // ==========================================
                        // 🧹 如果防抖被取消（用户又打字了），也要记得清理 Loading 装饰
                        // ==========================================
                        if (editor) editor.setDecorations(loadingDecorationType, []);
                        return [];
                    }
                }
            }
            return [];
        }
    };

    // 注册提供者
    let inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' }, 
        provider
    );

    context.subscriptions.push(insertMarkCmd, inlineProvider);
}
// For test, mock ai behaviour.
async function callMockAI(prompt: string, token: vscode.CancellationToken): Promise<string> {
    console.log(`🔧 调用 AI，提示: "${prompt}"`);
    
    // 模拟网络延迟（1.5秒）
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
    
    let aiResponse = '';
    if (prompt.toLowerCase().includes('函数') || prompt.toLowerCase().includes('function')) {
        aiResponse = `\n// AI 根据 "${prompt}" 生成的函数\nfunction aiGeneratedFunction() {\n    console.log("执行成功");\n    return true;\n}`;
    } else if (prompt.toLowerCase().includes('类') || prompt.toLowerCase().includes('class')) {
        aiResponse = `\n// AI 根据 "${prompt}" 生成的类\nclass AIGeneratedClass {\n    constructor() {\n        this.value = "AI 生成";\n    }\n}`;
    } else if (prompt.toLowerCase().includes('循环') || prompt.toLowerCase().includes('loop')) {
        aiResponse = `\n// AI 根据 "${prompt}" 生成的循环\nfor (let i = 0; i < 10; i++) {\n    console.log(\`迭代次数: \${i}\`);\n}`;
    } else {
        aiResponse = `\n// AI 根据 "${prompt}" 生成的代码\nconst result = "AI 生成的代码块";\nconsole.log(result);`;
    }
    
    return aiResponse;
}

//TBD， enter the prompt & AST tree text and get the aioutput.
async function callAI(prompt: string, token: vscode.CancellationToken): Promise<string> {
    
    let aiResponse = '';
    
    return aiResponse;
}

export function deactivate() {}