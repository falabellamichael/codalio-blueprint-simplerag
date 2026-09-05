import os
import re

BUNDLE_PATH = r"D:\PyMu\work_on_rag-main\GUI\app.bundle.js"
STYLE_PATH = r"D:\PyMu\work_on_rag-main\GUI\style.css"

with open(BUNDLE_PATH, "r", encoding="utf-8") as f:
    bundle = f.read()

# 1. Update payload.thinking_enabled in runGraphAnalysisChat
old_thinking_code = """        payload.long_running = true;
        payload.temperature = 0.3;
        payload.thinking_enabled = false;
        payload.reasoning_effort = 'none';"""

new_thinking_code = """        payload.long_running = true;
        payload.temperature = 0.3;
        payload.thinking_enabled = options.isContinuation
            ? false
            : (options.thinking_enabled !== undefined
                ? Boolean(options.thinking_enabled)
                : Boolean(state.settings?.general?.thinking_enabled ?? state.settings?.thinking_enabled ?? false));
        payload.reasoning_effort = payload.thinking_enabled ? 'low' : 'none';"""

if old_thinking_code in bundle:
    bundle = bundle.replace(old_thinking_code, new_thinking_code, 1)
    print("Updated payload.thinking_enabled in runGraphAnalysisChat")
else:
    print("WARNING: old_thinking_code not found in bundle")

# 2. Update cleanContinuationText through renderAiAnalysisResultLayout
old_helper_block = """function cleanContinuationText(text) {
    // Strip accumulated length-limit notices so the model gets clean prior text.
    return String(text || '')
        .replace(/\\[⚠️\\s*(?:Context window|Output|Response length) limit reached[^\\]]*\\]/gi, '')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
}

function startGraphAnalysisContinuation(options = {}, existingButton = null) {
    const nextOptions = {
        ...options,
        panelTarget: options.panelTarget || (typeof createGraphAnalysisPanelTarget === 'function'
            ? createGraphAnalysisPanelTarget(getGraphAnalysisSectionId(options))
            : null)
    };
    // Store panelTarget so renderers can forward it through the re-render chain.
    nextOptions._continuationPanelTarget = nextOptions.panelTarget;
    const button = existingButton
        || (typeof el !== 'undefined' && el?.listContent ? el.listContent.querySelector('[data-analysis-action="continue-analysis"]') : null);
    if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> <span>Continuing analysis…</span>';
    }
    const rawPriorText = getPriorAnalysisText(nextOptions);
    const priorText = cleanContinuationText(rawPriorText);
    const userPrompt = priorText
        ? `Continue from where you left off and finish the analysis. Here is what you have already written:\\n\\n${priorText}\\n\\nNow continue from the end and complete the findings.`
        : 'Continue from where you left off and finish the analysis.';
    const systemPrompt = nextOptions.systemPrompt || 'You are an AI analyst. Continue the prior analysis from where it was truncated and complete the findings. Use the supplied prior text as your starting point.';
    runGraphAnalysisChat(userPrompt, systemPrompt, {
        ...nextOptions,
        isContinuation: true,
        useWorkspaceContext: false
    }).catch(() => {
        if (button?.isConnected) {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i> <span>Continue analysis</span>';
        }
    });
}

function bindGraphAnalysisLiveStreamContinuation(options = {}) {
    if (typeof el === 'undefined' || !el?.listContent) return;
    const liveSection = el.listContent.querySelector('.ai-analysis-live-stream');
    if (!liveSection || liveSection.dataset.continuationBound === 'true') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidebar-btn ai-analysis-primary-action ai-analysis-live-continue';
    button.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i> <span>Continue analysis</span>';
    button.addEventListener('click', () => startGraphAnalysisContinuation(options, button));
    liveSection.appendChild(button);
    liveSection.dataset.continuationBound = 'true';
}

function finalizeGraphAnalysisContinuation(options, response) {
    const text = String(response || '').trim();
    if (!text || isGraphAnalysisFailureText(text)) return;
    const rawPriorText = getPriorAnalysisText(options);
    const priorText = cleanContinuationText(rawPriorText);
    const mergedText = priorText ? `${priorText}\\n\\n${text}` : text;
    saveGraphAnalysisContinuationOnActiveTab(options, mergedText);
    // Forward panelTarget through the render chain so the next Continue button works.
    const renderOptions = {
        ...options,
        continuation: true,
        panelTarget: options.panelTarget || options._continuationPanelTarget || null
    };
    if (renderGraphAnalysisContinuationResult(renderOptions, mergedText)) {
        if (typeof el !== 'undefined' && el?.listContent) el.listContent.scrollTop = 0;
    } else if (hasGraphAnalysisLengthLimit(text)) {
        bindGraphAnalysisLiveStreamContinuation(options);
    }
}

function renderAiAnalysisResultLayout(config = {}) {
    const origin = getAiAnalysisOrigin(config.options || {});
    const originDetails = getAiAnalysisOriginDetails(origin);
    const reasoningState = getAiAnalysisReasoningState(config.options || {}, origin);
    const kind = String(config.kind || 'general').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
    const iconClass = String(config.iconClass || 'fa-brain').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'fa-brain';
    const metaItems = [...(Array.isArray(config.meta) ? config.meta : []), originDetails];
    if (reasoningState.thinking) {
        const responseHalved = reasoningState.mode === 'visible-half';
        metaItems.push({
            label: responseHalved ? 'Reasoning visible · 50% response' : 'Reasoning visible',
            iconClass: 'fa-brain',
            tone: 'reasoning',
            title: responseHalved
                ? 'This model requires visible reasoning, so the response budget was halved.'
                : 'This model emitted reasoning after AI Analysis requested a direct answer. Its next analysis will use the half-response fallback.'
        });
    }
    if ((config.options?.continuation === true || config.options?.isContinuation === true || config.continuation === true) && origin !== 'fresh') {
        metaItems.push({ label: 'Continuation', iconClass: 'fa-arrow-turn-down', tone: 'cache', title: 'Follow-up completion of a truncated analysis' });
    }
    const webSearchHtml = renderGraphWebSearchPanel(config.options?.webSearch);
    let actionsHtml = config.actionsHtml || '';
    if (hasGraphAnalysisLengthLimit(config.bodyHtml) && !actionsHtml.includes('data-analysis-action="continue-analysis"')) {
        actionsHtml += `
                <button type="button" class="sidebar-btn ai-analysis-primary-action" data-analysis-action="continue-analysis">
                    <i class="fas fa-play" aria-hidden="true"></i>
                    <span>Continue analysis</span>
                </button>
            `;
    }
    return `
            <article class="ai-analysis-result" data-analysis-kind="${escapeHTML(kind)}" data-analysis-origin="${escapeHTML(origin)}" aria-labelledby="ai-analysis-subject">
                <header class="ai-analysis-header">
                    <div class="ai-analysis-heading">
                        <span class="ai-analysis-icon" aria-hidden="true"><i class="fas ${escapeHTML(iconClass)}"></i></span>
                        <div class="ai-analysis-heading-copy">
                            <div class="ai-analysis-eyebrow">${escapeHTML(config.eyebrow || 'AI ANALYSIS')}</div>
                            <h2 id="ai-analysis-subject">${escapeHTML(config.title || 'Analysis')}</h2>
                        </div>
                    </div>
                    <div class="ai-analysis-meta" aria-label="Analysis details">
                        ${metaItems.map(renderAiAnalysisMetaChip).join('')}
                    </div>
                </header>
                ${renderAiAnalysisReasoningFallback(reasoningState)}
                <section class="ai-analysis-content" aria-label="Analysis findings">${config.bodyHtml || ''}</section>
                ${webSearchHtml}
                ${config.evidenceHtml || ''}
                ${actionsHtml ? `<footer class="ai-analysis-actions">${actionsHtml}</footer>` : ''}
            </article>
        `;
}"""

new_helper_block = """const MAX_GRAPH_ANALYSIS_AUTO_COMPACTIONS = 3;

function isGraphAnalysisContextOverflow(error) {
    if (!error) return false;
    const msg = String(
        (error && (error.message || error.detail || error.error || error.code || error.statusText)) || error || ''
    ).toLowerCase();
    return (
        msg.includes('context length') ||
        msg.includes('context window') ||
        msg.includes('context overflow') ||
        msg.includes('context_length_exceeded') ||
        msg.includes('maximum context') ||
        msg.includes('max context') ||
        msg.includes('max_tokens') ||
        msg.includes('n_ctx') ||
        msg.includes('prompt is too long') ||
        msg.includes('prompt too long') ||
        msg.includes('too many tokens') ||
        msg.includes('token limit') ||
        msg.includes('token budget exceeded') ||
        msg.includes('exceeds token') ||
        msg.includes('exceeds maximum') ||
        msg.includes('out of memory') ||
        msg.includes('out of context') ||
        msg.includes('stream ended before completion') ||
        (msg.includes('400') && (msg.includes('token') || msg.includes('context') || msg.includes('length')))
    );
}

function estimateGraphAnalysisTokens(text) {
    if (!text) return 0;
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    return Math.max(1, Math.round(str.length / 3.8));
}

function cleanGraphAnalysisThinking(text) {
    return String(text || '')
        .replace(/<think>[\\s\\S]*?<\\/think>/gi, '')
        .replace(/\\[thinking\\][\\s\\S]*?\\[\\/thinking\\]/gi, '')
        .trim();
}

/**
 * High-tech Context Compactor for Knowledge Graph Analysis
 *
 * Compresses accumulated analysis findings and thinking traces into a dense,
 * structured compaction block preserving:
 * 1. Key established concepts, findings, and relationships
 * 2. Active graph context and evidence
 * 3. Immediate continuation anchor for seamless resumption
 */
function compactGraphAnalysisContext(rawPriorText, options = {}) {
    const cycle = Math.min(MAX_GRAPH_ANALYSIS_AUTO_COMPACTIONS, Math.max(1, Number(options.compactionCount || 1)));
    const cleanText = cleanContinuationText(cleanGraphAnalysisThinking(rawPriorText));
    const originalTokens = estimateGraphAnalysisTokens(rawPriorText);

    // If text is short (< 280 tokens) and not force-compacted, light cleanup
    if (originalTokens < 280 && !options.forceAggressiveCompaction && cycle === 1) {
        return {
            cycle,
            promptText: cleanText,
            summary: cleanText,
            originalTokens,
            compactedTokens: estimateGraphAnalysisTokens(cleanText),
            savedTokens: Math.max(0, originalTokens - estimateGraphAnalysisTokens(cleanText)),
            savedPercent: 0,
            isCompacted: false
        };
    }

    const lines = cleanText.split('\\n').map(l => l.trim()).filter(Boolean);
    const keyFindings = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#') || line.startsWith('*') || line.startsWith('-') || line.startsWith('•') || line.includes(':')) {
            if (line.length > 8 && line.length < 260) {
                keyFindings.push(line.replace(/^[#*-•\\s]+/, '• '));
            }
        } else if (line.length > 30 && keyFindings.length < 10) {
            const firstSentence = line.split(/[.!?]\\s+/)[0];
            if (firstSentence && firstSentence.length > 15) {
                keyFindings.push(`• ${firstSentence}.`);
            }
        }
    }

    // Keep the last 1-2 sentences as immediate resumption anchor
    const lastChunk = lines.slice(-3).join(' ');
    const sentences = lastChunk.split(/(?<=[.!?])\\s+/).filter(Boolean);
    const anchor = sentences.slice(-2).join(' ') || lines[lines.length - 1] || 'Continuing findings.';

    const selectedFindings = keyFindings.slice(0, 10);
    const compactedSections = [
        `### Established Findings (Compacted Cycle ${cycle}/${MAX_GRAPH_ANALYSIS_AUTO_COMPACTIONS}):`,
        selectedFindings.length ? selectedFindings.join('\\n') : '• Analyzed initial graph connections and node properties.',
        '',
        `### Immediate Continuation Anchor:`,
        `"${anchor.slice(0, 320)}"`
    ].join('\\n');

    const compactedTokens = estimateGraphAnalysisTokens(compactedSections);
    const savedTokens = Math.max(0, originalTokens - compactedTokens);
    const savedPercent = originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 100) : 0;

    return {
        cycle,
        promptText: compactedSections,
        summary: compactedSections,
        originalTokens,
        compactedTokens,
        savedTokens,
        savedPercent,
        isCompacted: true
    };
}

function cleanContinuationText(text) {
    // Strip accumulated length-limit notices, out-of-context notices, and thinking blocks so the model gets clean prior text.
    return String(text || '')
        .replace(/<think>[\\s\\S]*?<\\/think>/gi, '')
        .replace(/\\[thinking\\][\\s\\S]*?\\[\\/thinking\\]/gi, '')
        .replace(/\\[⚠️\\s*(?:Context window|Output|Response length|Out of context)[^\\]]*\\]/gi, '')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
}

function startGraphAnalysisContinuation(options = {}, existingButton = null) {
    const nextOptions = {
        ...options,
        panelTarget: options.panelTarget || (typeof createGraphAnalysisPanelTarget === 'function'
            ? createGraphAnalysisPanelTarget(getGraphAnalysisSectionId(options))
            : null)
    };
    nextOptions._continuationPanelTarget = nextOptions.panelTarget;

    const currentCount = Number(nextOptions.compactionCount || 0);
    const maxCompactions = Number(nextOptions.maxAutoCompactions || MAX_GRAPH_ANALYSIS_AUTO_COMPACTIONS);

    const button = existingButton
        || (typeof el !== 'undefined' && el?.listContent ? el.listContent.querySelector('[data-analysis-action="continue-analysis"]') : null);
    if (button) {
        button.disabled = true;
        const progressLabel = currentCount > 0
            ? `Continuing analysis (${currentCount}/${maxCompactions})…`
            : 'Continuing analysis…';
        button.innerHTML = `<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> <span>${progressLabel}</span>`;
    }

    const rawPriorText = getPriorAnalysisText(nextOptions);
    const compaction = compactGraphAnalysisContext(rawPriorText, nextOptions);
    nextOptions._lastCompaction = compaction;

    let userPrompt = '';
    if (compaction.isCompacted) {
        userPrompt = [
            `Continue from where you left off and finish the analysis. Here is what you have already written (compacted cycle ${compaction.cycle}/${maxCompactions}; saved ~${compaction.savedTokens} tokens):\\n\\n${compaction.promptText}\\n\\nNow continue from the end and complete the findings.`
        ].join('\\n');
    } else {
        const priorText = cleanContinuationText(rawPriorText);
        userPrompt = priorText
            ? `Continue from where you left off and finish the analysis. Here is what you have already written:\\n\\n${priorText}\\n\\nNow continue from the end and complete the findings.`
            : 'Continue from where you left off and finish the analysis.';
    }

    const systemPrompt = nextOptions.systemPrompt || 'You are an AI analyst. Continue the prior analysis from where it was truncated and complete the findings. Use the supplied prior text as your starting point.';

    // Show live UI compaction notice if container is active
    if (compaction.isCompacted && typeof el !== 'undefined' && el?.listContent) {
        const liveStream = el.listContent.querySelector('.ai-analysis-live-stream');
        if (liveStream) {
            let noticeEl = liveStream.querySelector('.ai-analysis-compaction-notice');
            if (!noticeEl) {
                noticeEl = document.createElement('div');
                noticeEl.className = 'ai-analysis-compaction-notice';
                liveStream.insertBefore(noticeEl, liveStream.firstChild);
            }
            noticeEl.innerHTML = `<i class="fas fa-bolt" aria-hidden="true"></i> <span>Context compacted (${compaction.cycle}/${maxCompactions} · saved ~${compaction.savedTokens} tokens) — continuing analysis…</span>`;
        }
    }

    return runGraphAnalysisChat(userPrompt, systemPrompt, {
        ...nextOptions,
        isContinuation: true,
        useWorkspaceContext: false
    }).then(res => {
        if (!nextOptions._skipAutoFinalize) {
            finalizeGraphAnalysisContinuation(nextOptions, res);
        }
        return res;
    }).catch(error => {
        if (isGraphAnalysisContextOverflow(error) && currentCount < maxCompactions) {
            const nextCount = currentCount + 1;
            console.warn(`[GraphAnalysis] Context overflow detected, compacting (${nextCount}/${maxCompactions}) and retrying...`, error);
            if (button?.isConnected) {
                button.disabled = true;
                button.innerHTML = `<i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i> <span>Compacting context (${nextCount}/${maxCompactions})…</span>`;
            }
            return startGraphAnalysisContinuation({
                ...nextOptions,
                compactionCount: nextCount,
                forceAggressiveCompaction: true,
                autoCompact: true,
                isAutoContinuing: true
            }, button);
        }

        if (button?.isConnected) {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i> <span>Continue analysis</span>';
        }

        if (isGraphAnalysisContextOverflow(error)) {
            const outNotice = `\\n\\n[⚠️ Out of context: Context limit reached after ${maxCompactions} automatic compactions. Click 'Continue' below to let it finish.]`;
            const prior = cleanContinuationText(rawPriorText);
            const merged = `${prior}${outNotice}`;
            saveGraphAnalysisContinuationOnActiveTab(nextOptions, merged);
            renderGraphAnalysisContinuationResult({ ...nextOptions, continuation: true, compactionCount: maxCompactions }, merged);
            bindAiAnalysisActionClicks(nextOptions);
        }
    });
}

function bindGraphAnalysisLiveStreamContinuation(options = {}) {
    if (typeof el === 'undefined' || !el?.listContent) return;
    const liveSection = el.listContent.querySelector('.ai-analysis-live-stream');
    if (!liveSection || liveSection.dataset.continuationBound === 'true') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sidebar-btn ai-analysis-primary-action ai-analysis-live-continue';
    button.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i> <span>Continue analysis</span>';
    button.addEventListener('click', () => startGraphAnalysisContinuation(options, button));
    liveSection.appendChild(button);
    liveSection.dataset.continuationBound = 'true';
}

function finalizeGraphAnalysisContinuation(options = {}, response) {
    const text = String(response || '').trim();
    if (!text || isGraphAnalysisFailureText(text)) return;
    const rawPriorText = getPriorAnalysisText(options);
    const priorText = cleanContinuationText(rawPriorText);
    const cleanNew = cleanContinuationText(text);
    const mergedText = priorText ? `${priorText}\\n\\n${cleanNew}` : cleanNew;

    const hasLimit = hasGraphAnalysisLengthLimit(text);
    const currentCount = Number(options.compactionCount || 0);
    const maxCompactions = Number(options.maxAutoCompactions || MAX_GRAPH_ANALYSIS_AUTO_COMPACTIONS);
    const shouldAutoContinue = Boolean(options.autoCompact || options.isAutoContinuing);

    if (hasLimit && shouldAutoContinue && currentCount < maxCompactions) {
        // Auto-compact & auto-continue on its own (cycle 1, 2, or 3)
        const nextCount = currentCount + 1;
        saveGraphAnalysisContinuationOnActiveTab(options, mergedText);

        const renderOptions = {
            ...options,
            continuation: true,
            compactionCount: nextCount,
            panelTarget: options.panelTarget || options._continuationPanelTarget || null
        };
        // Render current progress
        if (renderGraphAnalysisContinuationResult(renderOptions, mergedText)) {
            if (typeof el !== 'undefined' && el?.listContent) el.listContent.scrollTop = 0;
        }

        // Keep continuing autonomously!
        setTimeout(() => {
            void startGraphAnalysisContinuation({
                ...renderOptions,
                compactionCount: nextCount,
                autoCompact: true,
                isAutoContinuing: true
            });
        }, 120);
        return;
    }

    // Either completed without limit, OR manual continuation without autoCompact, OR reached 3 compactions!
    let textToSave = mergedText;
    if (hasLimit) {
        if (currentCount >= maxCompactions) {
            // Reached 3 compactions and still limited: stop, say out of context, show Continue
            const notice = `\\n\\n[⚠️ Context window limit reached after ${maxCompactions} automatic compactions. Starting with a fresh context window for your next message—click 'Continue' below to let it finish.]`;
            textToSave = `${cleanContinuationText(mergedText)}${notice}`;
        } else {
            // Normal limit notice for manual continuation
            const notice = `\\n\\n[⚠️ Context window limit reached. The response filled the available context. Starting with a fresh context window for your next message—click 'Continue' below to let it finish.]`;
            textToSave = `${cleanContinuationText(mergedText)}${notice}`;
        }
    }

    saveGraphAnalysisContinuationOnActiveTab(options, textToSave);
    const renderOptions = {
        ...options,
        continuation: true,
        compactionCount: currentCount,
        panelTarget: options.panelTarget || options._continuationPanelTarget || null
    };
    if (renderGraphAnalysisContinuationResult(renderOptions, textToSave)) {
        if (typeof el !== 'undefined' && el?.listContent) el.listContent.scrollTop = 0;
    } else if (hasGraphAnalysisLengthLimit(textToSave)) {
        bindGraphAnalysisLiveStreamContinuation(options);
    }
}

function renderAiAnalysisResultLayout(config = {}) {
    const origin = getAiAnalysisOrigin(config.options || {});
    const originDetails = getAiAnalysisOriginDetails(origin);
    const reasoningState = getAiAnalysisReasoningState(config.options || {}, origin);
    const kind = String(config.kind || 'general').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
    const iconClass = String(config.iconClass || 'fa-brain').trim().replace(/[^a-zA-Z0-9_-]/g, '') || 'fa-brain';
    const metaItems = [...(Array.isArray(config.meta) ? config.meta : []), originDetails];
    if (reasoningState.thinking) {
        const responseHalved = reasoningState.mode === 'visible-half';
        metaItems.push({
            label: responseHalved ? 'Reasoning visible · 50% response' : 'Reasoning visible',
            iconClass: 'fa-brain',
            tone: 'reasoning',
            title: responseHalved
                ? 'This model requires visible reasoning, so the response budget was halved.'
                : 'This model emitted reasoning after AI Analysis requested a direct answer. Its next analysis will use the half-response fallback.'
        });
    }
    const compactionCount = Number(config.options?.compactionCount || 0);
    if (compactionCount > 0) {
        if (hasGraphAnalysisLengthLimit(config.bodyHtml)) {
            metaItems.push({
                label: `${compactionCount}x Compressed · Out of context`,
                iconClass: 'fa-compress',
                tone: 'warning',
                title: `Analysis compressed ${compactionCount} time(s). Context window limit reached—click Continue to resume.`
            });
        } else {
            metaItems.push({
                label: `${compactionCount}x Compressed`,
                iconClass: 'fa-compress',
                tone: 'cache',
                title: `Context was automatically compressed ${compactionCount} time(s) to fit within context window.`
            });
        }
    }
    if ((config.options?.continuation === true || config.options?.isContinuation === true || config.continuation === true) && origin !== 'fresh' && compactionCount === 0) {
        metaItems.push({ label: 'Continuation', iconClass: 'fa-arrow-turn-down', tone: 'cache', title: 'Follow-up completion of a truncated analysis' });
    }
    const webSearchHtml = renderGraphWebSearchPanel(config.options?.webSearch);
    let actionsHtml = config.actionsHtml || '';
    if (hasGraphAnalysisLengthLimit(config.bodyHtml) && !actionsHtml.includes('data-analysis-action="continue-analysis"')) {
        actionsHtml += `
                <button type="button" class="sidebar-btn ai-analysis-primary-action" data-analysis-action="continue-analysis">
                    <i class="fas fa-play" aria-hidden="true"></i>
                    <span>Continue analysis</span>
                </button>
            `;
    }
    return `
            <article class="ai-analysis-result" data-analysis-kind="${escapeHTML(kind)}" data-analysis-origin="${escapeHTML(origin)}" aria-labelledby="ai-analysis-subject">
                <header class="ai-analysis-header">
                    <div class="ai-analysis-heading">
                        <span class="ai-analysis-icon" aria-hidden="true"><i class="fas ${escapeHTML(iconClass)}"></i></span>
                        <div class="ai-analysis-heading-copy">
                            <div class="ai-analysis-eyebrow">${escapeHTML(config.eyebrow || 'AI ANALYSIS')}</div>
                            <h2 id="ai-analysis-subject">${escapeHTML(config.title || 'Analysis')}</h2>
                        </div>
                    </div>
                    <div class="ai-analysis-meta" aria-label="Analysis details">
                        ${metaItems.map(renderAiAnalysisMetaChip).join('')}
                    </div>
                </header>
                ${renderAiAnalysisReasoningFallback(reasoningState)}
                <section class="ai-analysis-content" aria-label="Analysis findings">${config.bodyHtml || ''}</section>
                ${webSearchHtml}
                ${config.evidenceHtml || ''}
                ${actionsHtml ? `<footer class="ai-analysis-actions">${actionsHtml}</footer>` : ''}
            </article>
        `;
}"""

if old_helper_block in bundle:
    bundle = bundle.replace(old_helper_block, new_helper_block, 1)
    print("Updated helper block in app.bundle.js")
else:
    print("WARNING: old_helper_block not found in bundle")

# 3. Update handleSemanticBoneNodeClick
old_bone_catch = """        saveSemanticBoneAnalysisOnActiveTab(context, sectionId, aiResponse, cacheDescriptor, { webSearch });
        renderSemanticBoneGraphAnalysisResult(context, aiResponse, { panelTarget, webSearch });
    } catch (error) {
        console.error('handleSemanticBoneNodeClick error:', error);
        renderJournalGraphAnalysisError(error, { panelTarget });
    }"""

new_bone_catch = """        saveSemanticBoneAnalysisOnActiveTab(context, sectionId, aiResponse, cacheDescriptor, { webSearch });
        renderSemanticBoneGraphAnalysisResult(context, aiResponse, { panelTarget, webSearch });
        if (hasGraphAnalysisLengthLimit(aiResponse)) {
            void startGraphAnalysisContinuation({
                panelTarget,
                sectionId,
                mode,
                autoCompact: true,
                compactionCount: 1,
                isAutoContinuing: true,
                webSearch
            });
        }
    } catch (error) {
        if (isGraphAnalysisContextOverflow(error)) {
            console.warn('[SemanticBone] Initial analysis overflowed context, starting auto-compacted continuation...', error);
            const initialSeed = `Analyzing semantic molecule: ${focusTitle}.\\n\\nEmbedding similarity: ${Math.round(context.similarity * 100)}%.\\n\\n[⚠️ Context window limit reached. Initial request exceeded context. Auto-compacting and continuing.]`;
            saveSemanticBoneAnalysisOnActiveTab(context, sectionId, initialSeed, cacheDescriptor, { webSearch: null });
            renderSemanticBoneGraphAnalysisResult(context, initialSeed, { panelTarget });
            void startGraphAnalysisContinuation({
                panelTarget,
                sectionId,
                mode,
                autoCompact: true,
                compactionCount: 1,
                isAutoContinuing: true
            });
            return;
        }
        console.error('handleSemanticBoneNodeClick error:', error);
        renderJournalGraphAnalysisError(error, { panelTarget });
    }"""

if old_bone_catch in bundle:
    bundle = bundle.replace(old_bone_catch, new_bone_catch, 1)
    print("Updated handleSemanticBoneNodeClick in app.bundle.js")
else:
    print("WARNING: old_bone_catch not found in bundle")

# 4. Update handleHybridGraphNodeClick
old_hybrid_catch = """        saveHybridGraphAnalysisOnActiveTab(tabId, context, aiResponse, {
            webSearchEnabled,
            webSearch
        });
        renderHybridGraphNodeAnalysisResult(context, aiResponse, {
            panelTarget,
            webSearch
        });
        return true;
    } catch (error) {
        console.error('handleHybridGraphNodeClick error:', error);
        renderHybridGraphNodeAnalysisError(error, { panelTarget });
        return false;
    }"""

new_hybrid_catch = """        saveHybridGraphAnalysisOnActiveTab(tabId, context, aiResponse, {
            webSearchEnabled,
            webSearch
        });
        renderHybridGraphNodeAnalysisResult(context, aiResponse, {
            panelTarget,
            webSearch
        });
        if (hasGraphAnalysisLengthLimit(aiResponse)) {
            void startGraphAnalysisContinuation({
                panelTarget,
                sectionId,
                mode,
                tabId,
                autoCompact: true,
                compactionCount: 1,
                isAutoContinuing: true,
                webSearch
            });
        }
        return true;
    } catch (error) {
        if (isGraphAnalysisContextOverflow(error)) {
            console.warn('[HybridGraph] Initial analysis overflowed context, starting auto-compacted continuation...', error);
            const initialSeed = `Analyzing vector entity: ${focusLabel}.\\n\\nClassification: ${focus.graph_classification || 'Record'}.\\n\\n[⚠️ Context window limit reached. Initial request exceeded context. Auto-compacting and continuing.]`;
            saveHybridGraphAnalysisOnActiveTab(tabId, context, initialSeed, { webSearchEnabled: false, webSearch: null });
            renderHybridGraphNodeAnalysisResult(context, initialSeed, { panelTarget });
            void startGraphAnalysisContinuation({
                panelTarget,
                sectionId,
                mode,
                tabId,
                autoCompact: true,
                compactionCount: 1,
                isAutoContinuing: true
            });
            return true;
        }
        console.error('handleHybridGraphNodeClick error:', error);
        renderHybridGraphNodeAnalysisError(error, { panelTarget });
        return false;
    }"""

if old_hybrid_catch in bundle:
    bundle = bundle.replace(old_hybrid_catch, new_hybrid_catch, 1)
    print("Updated handleHybridGraphNodeClick in app.bundle.js")
else:
    print("WARNING: old_hybrid_catch not found in bundle")

# 5. Update bindAiAnalysisActionClicks to pass autoCompact
old_action_clicks = """function bindAiAnalysisActionClicks(options = {}) {
    if (typeof el === 'undefined' || !el?.listContent) return;
    const continueBtn = el.listContent.querySelector('[data-analysis-action="continue-analysis"]');
    if (continueBtn) {
        continueBtn.addEventListener('click', () => {
            startGraphAnalysisContinuation(options, continueBtn);
        });
    }
}"""

new_action_clicks = """function bindAiAnalysisActionClicks(options = {}) {
    if (typeof el === 'undefined' || !el?.listContent) return;
    const continueBtn = el.listContent.querySelector('[data-analysis-action="continue-analysis"]');
    if (continueBtn) {
        continueBtn.addEventListener('click', () => {
            startGraphAnalysisContinuation({
                ...options,
                autoCompact: true,
                compactionCount: 0,
                maxAutoCompactions: MAX_GRAPH_ANALYSIS_AUTO_COMPACTIONS
            }, continueBtn);
        });
    }
}"""

if old_action_clicks in bundle:
    bundle = bundle.replace(old_action_clicks, new_action_clicks, 1)
    print("Updated bindAiAnalysisActionClicks in app.bundle.js")
else:
    print("WARNING: old_action_clicks not found in bundle")

with open(BUNDLE_PATH, "w", encoding="utf-8") as f:
    f.write(bundle)
print("Saved updated app.bundle.js")

# 6. Add CSS for compaction notice in style.css
with open(STYLE_PATH, "r", encoding="utf-8") as f:
    css = f.read()

compaction_css = """
.ai-analysis-compaction-notice {
    margin: 8px 0 10px 0;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--ai-analysis-border, var(--border)) 65%);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-list, #1e1e1e) 90%);
    color: var(--text-secondary, #ccc);
    font-size: calc(9.5px * var(--workspace-text-scale, 1));
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    animation: fadeIn 0.2s ease-out;
}

.ai-analysis-compaction-notice i {
    color: var(--accent);
    font-size: 11px;
}
"""

if ".ai-analysis-compaction-notice" not in css:
    css += compaction_css
    with open(STYLE_PATH, "w", encoding="utf-8") as f:
        f.write(css)
    print("Added .ai-analysis-compaction-notice to style.css")
else:
    print(".ai-analysis-compaction-notice already in style.css")
