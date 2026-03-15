import * as vscode from 'vscode';

const TRIGGER_MARK = '//>';
const DEBOUNCE_DELAY = 800; // 0.8秒

// 存储正在进行的生成任务
const pendingGenerations = new Map<string, vscode.CancellationTokenSource>();

export function activate(context: vscode.ExtensionContext) {
    console.log('🔧 PromptLens 扩展已激活！');
    console.log('🔧 检查激活状态...');
    console.log('🔧 VS Code 版本:', vscode.version);
    console.log('🔧 扩展上下文:', context.extensionPath);
    
    // 检查 Inline Suggestions 设置
    const config = vscode.workspace.getConfiguration('editor');
    const inlineSuggestEnabled = config.get('inlineSuggest.enabled');
    console.log('🔧 editor.inlineSuggest.enabled:', inlineSuggestEnabled);
    
    if (!inlineSuggestEnabled) {
        vscode.window.showInformationMessage(
            'PromptLens: 请启用 Inline Suggestions 功能以获得最佳体验。',
            '启用设置'
        ).then(selection => {
            if (selection === '启用设置') {
                config.update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
            }
        });
    }

    // 1. 快捷鍵插入標記功能
    let insertMarkCmd = vscode.commands.registerCommand('promptlens.insertPromptMark', () => {
        console.log('🔧 执行插入标记命令');
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const position = editor.selection.active;
            editor.edit(editBuilder => {
                editBuilder.insert(position, `${TRIGGER_MARK} `);
            }).then(success => {
                console.log('🔧 插入标记成功:', success);
            });
        }
    });

    // 2. 核心功能：兩階段 Inline Completion
    const provider: vscode.InlineCompletionItemProvider = {
        async provideInlineCompletionItems(document, position, context, token) {
            console.log('🔧 Inline Completion 被调用');
            console.log('🔧 文档:', document.uri.toString());
            console.log('🔧 位置:', position.line, position.character);
            
            const lineText = document.lineAt(position.line).text;
            console.log('🔧 当前行文本:', lineText);
            
            const textBeforeCursor = lineText.substring(0, position.character);
            console.log('🔧 光标前文本:', textBeforeCursor);
            
            const markIndex = textBeforeCursor.indexOf(TRIGGER_MARK);
            console.log('🔧 找到标记位置:', markIndex);
            
            if (markIndex !== -1) {
                const promptText = textBeforeCursor.substring(markIndex + TRIGGER_MARK.length).trim();
                console.log('🔧 提取的提示文本:', promptText);
                
                if (promptText.length > 0) {
                    // 生成唯一标识符
                    const docId = document.uri.toString();
                    const line = position.line;
                    const char = position.character;
                    const generationId = `${docId}:${line}:${char}`;
                    console.log('🔧 生成任务ID:', generationId);
                    
                    // 取消之前的生成任务
                    if (pendingGenerations.has(generationId)) {
                        console.log('🔧 取消之前的任务');
                        pendingGenerations.get(generationId)?.cancel();
                        pendingGenerations.delete(generationId);
                    }
                    
                    // 创建新的取消令牌
                    const cts = new vscode.CancellationTokenSource();
                    pendingGenerations.set(generationId, cts);
                    
                    try {
                        // 第一阶段：立即显示加载提示
                        console.log('🔧 创建加载提示');
                        const loadingItem = new vscode.InlineCompletionItem(
                            "⏳ 正在生成代码...",
                            new vscode.Range(position, position)
                        );
                        loadingItem.description = "loading";
                        loadingItem.command = {
                            title: "取消生成",
                            command: "promptlens.cancelGeneration",
                            arguments: [generationId]
                        };
                        
                        // 立即返回加载提示（不要等待防抖）
                        console.log('🔧 立即返回加载提示');
                        
                        // 异步处理防抖和 AI 调用
                        setTimeout(async () => {
                            try {
                                console.log('🔧 开始防抖等待');
                                // 防抖等待
                                await new Promise<void>((resolve, reject) => {
                                    const timer = setTimeout(() => {
                                        if (cts.token.isCancellationRequested) {
                                            console.log('🔧 防抖期间被取消');
                                            reject(new Error('Cancelled'));
                                        } else {
                                            console.log('🔧 防抖完成');
                                            resolve();
                                        }
                                    }, DEBOUNCE_DELAY);
                                    
                                    cts.token.onCancellationRequested(() => {
                                        console.log('🔧 取消令牌触发');
                                        clearTimeout(timer);
                                        reject(new Error('Cancelled'));
                                    });
                                });
                                
                                console.log('🔧 调用 AI');
                                // 第二阶段：调用 AI 并显示结果
                                const aiResponse = await callAI(promptText, cts.token);
                                
                                if (cts.token.isCancellationRequested) {
                                    console.log('🔧 AI 调用后被取消');
                                    return;
                                }
                                
                                console.log('🔧 AI 返回结果:', aiResponse.substring(0, 50) + '...');
                                
                                // 触发重新请求 Inline Completion
                                // 这里需要一种方式通知 VS Code 更新 Inline Completion
                                // 目前 VS Code API 没有直接的方法，但我们可以尝试触发编辑器事件
                                
                            } catch (error) {
                                console.log('🔧 处理过程中出错:', error);
                            } finally {
                                pendingGenerations.delete(generationId);
                            }
                        }, 0);
                        
                        // 立即返回加载提示
                        return [loadingItem];
                        
                    } catch (error) {
                        console.log('🔧 初始处理出错:', error);
                        return [];
                    }
                }
            }
            console.log('🔧 没有找到有效标记，返回空数组');
            return [];
        }
    };

    // 3. 注册取消命令
    const cancelCmd = vscode.commands.registerCommand('promptlens.cancelGeneration', (generationId: string) => {
        console.log('🔧 取消生成命令:', generationId);
        if (pendingGenerations.has(generationId)) {
            pendingGenerations.get(generationId)?.cancel();
            pendingGenerations.delete(generationId);
            vscode.window.showInformationMessage('已取消代码生成');
        }
    });

    // 4. 注册提供者
    console.log('🔧 注册 Inline Completion 提供者');
    let inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' }, 
        provider
    );

    // 5. 添加状态栏项显示扩展状态
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(sparkle) PromptLens";
    statusBarItem.tooltip = "AI 代码生成工具 - 输入 //> 开始";
    statusBarItem.show();

    context.subscriptions.push(
        insertMarkCmd, 
        cancelCmd, 
        inlineProvider,
        statusBarItem
    );
    
    console.log('🔧 所有组件已注册完成');
}

// 模拟 AI 调用
async function callAI(prompt: string, token: vscode.CancellationToken): Promise<string> {
    console.log(`🔧 调用 AI: ${prompt}`);
    
    // 显示进度通知
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "PromptLens",
        cancellable: true
    }, async (progress, cancellationToken) => {
        progress.report({ message: "正在生成代码..." });
        
        // 合并取消令牌
        const mergedToken = new vscode.CancellationTokenSource();
        token.onCancellationRequested(() => mergedToken.cancel());
        cancellationToken.onCancellationRequested(() => mergedToken.cancel());
        
        // 模拟网络延迟
        for (let i = 0; i < 10; i++) {
            if (mergedToken.token.isCancellationRequested) {
                throw new Error('Cancelled');
            }
            await new Promise(resolve => setTimeout(resolve, 150));
            progress.report({ increment: 10 });
        }
        
        return;
    });
    
    if (token.isCancellationRequested) {
        throw new Error('Cancelled');
    }
    
    // 模拟 AI 响应
    return `\n// AI 根据 "${prompt}" 生成的代码\nfunction generatedCode() {\n    console.log("这是 AI 生成的代码");\n    // 更多代码...\n}`;
}

export function deactivate() {
    console.log('🔧 PromptLens 扩展已停用');
    // 清理所有 pending 的任务
    pendingGenerations.forEach(cts => cts.dispose());
    pendingGenerations.clear();
}