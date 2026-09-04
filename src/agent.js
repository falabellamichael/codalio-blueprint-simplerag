/*
 * Codalio Blueprint — agent runtime.
 *
 * Executes a skill as a visible sequence of steps: clarifying questions, then
 * the lenses/phases, then the document write. Every model turn becomes a step
 * the user can open and read (prompt + streamed output), so the run looks like
 * a Cursor agent trace rather than a single black-box answer.
 */
(function defineBlueprintAgent() {
    'use strict';

    if (window.__codalioBlueprintAgent) return;

    const core = window.__codalioBlueprintCore;
    const skills = window.__codalioBlueprintSkills;

    // Fallbacks for headless runs; the live values come from settings
    // (Agent -> Model -> Prompt preview length).
    const MAX_PROMPT_PREVIEW = 4000;
    const MAX_STEP_TEXT = 60000;

    function promptPreview(prompt, limit) {
        const text = String(prompt || '');
        const max = Number.isFinite(Number(limit)) && Number(limit) > 0
            ? Number(limit)
            : MAX_PROMPT_PREVIEW;
        return text.length > max
            ? `${text.slice(0, max)}\n\n… (${(text.length - max).toLocaleString()} more characters)`
            : text;
    }

    function bounded(text) {
        const value = String(text || '');
        return value.length > MAX_STEP_TEXT ? `${value.slice(0, MAX_STEP_TEXT)}\n\n… truncated` : value;
    }

    function makeStep(overrides) {
        return Object.assign({
            id: core.uid('step'),
            kind: 'notice',
            label: '',
            summary: '',
            substatus: '',
            status: 'pending',
            text: '',
            thinking: '',
            promptPreview: '',
            error: '',
            open: false,
            startedAt: 0,
            elapsedMs: 0,
            cancelId: '',
            tokenCount: 0,
            tokensPerSec: 0
        }, overrides || {});
    }

    function finishStep(step, status) {
        step.status = status;
        if (step.startedAt) step.elapsedMs = Date.now() - step.startedAt;
        step.substatus = '';
        step.streaming = false;
        step.liveElement = null;
        step.liveThinkingElement = null;
        return step;
    }

    /**
     * Append the user's standing guidance to a system prompt. Guidance is set in
     * Settings -> Documents -> Standing guidance and applies to every turn, so
     * house style and hard constraints hold across the whole run.
     */
    function systemPromptWith(base, settings) {
        const guidance = String((settings && settings.extraGuidance) || '').trim();
        if (!guidance) return base;
        return `${base}\n\n## Additional standing instructions from the user\n${guidance}`;
    }

    function stripContinuationPreamble(text) {
        return String(text || '').replace(
            /^(?:Here is the continuation(?:\s+of the response)?|Continuing from where (?:I|we) left off|Continuing(?: generation)?|As requested, continuing)\s*[:—–-]?\s*/i,
            ''
        );
    }

    function stitchContinuationText(prior, chunk) {
        const p = String(prior || '');
        let c = stripContinuationPreamble(String(chunk || ''));
        if (!c) return p;
        if (!p) return c;

        const maxOverlap = Math.min(200, p.length, c.length);
        for (let len = maxOverlap; len >= 6; len--) {
            const pTail = p.slice(-len);
            const cHead = c.slice(0, len);
            if (pTail.toLowerCase() === cHead.toLowerCase()) {
                c = c.slice(len);
                break;
            }
        }

        const pEndsWithSpace = /\s$/.test(p);
        const cStartsWithSpace = /^\s/.test(c);
        if (pEndsWithSpace || cStartsWithSpace) {
            return p + c;
        }

        if (/[.!?:;)\n]$/.test(p)) {
            return p + ' ' + c;
        }

        if (/^[A-Z]/.test(c) && /[a-z0-9]$/.test(p)) {
            return p + ' ' + c;
        }

        return p + c;
    }

    function buildContinuationPrompt(originalPrompt, accumulatedText) {
        const cleanText = (core && typeof core.stripOutputLimitNotice === 'function')
            ? core.stripOutputLimitNotice(accumulatedText)
            : String(accumulatedText || '').replace(/\[⚠️\s*(?:Context window|Output|Response length) limit reached[^\]]*\]/gi, '').trim();
        
        const tailLength = 1200;
        const tail = cleanText.length > tailLength ? cleanText.slice(-tailLength) : cleanText;
        
        const headings = (cleanText.match(/^#{1,4}\s+.+$/gm) || [])
            .map(h => h.trim())
            .slice(-5);
        const headingsContext = headings.length > 0
            ? ['Sections started/completed so far:', ...headings.map(h => `- ${h}`), ''].join('\n')
            : '';

        return [
            originalPrompt,
            '',
            '---',
            '# CONTINUATION REQUIRED (OUTPUT LIMIT REACHED)',
            'Your previous response reached the output token limit and was cut off before completing all sections.',
            headingsContext,
            'Here is the tail of the text you generated so far:',
            '```markdown',
            tail,
            '```',
            '',
            'TASK: Continue generating seamlessly from the exact character/point where the text above ended.',
            'CRITICAL RULES:',
            '1. Do NOT restart from the beginning.',
            '2. Do NOT repeat sections or paragraphs that were already generated above.',
            '3. Produce all remaining sections until the entire output contract is completely fulfilled.',
            '4. Return only the continuation text.'
        ].join('\n');
    }

    /**
     * Run one model turn as a visible step. The step streams into its own live
     * DOM node so the user watches tokens arrive, exactly like an agent trace.
     */
    async function runModelStep(step, options, hooks) {
        const settings = options.settings || core.readSettings();
        step.status = 'running';
        step.streaming = true;
        step.startedAt = Date.now();
        step.promptPreview = promptPreview(options.prompt, settings.maxPromptChars);
        step.substatus = options.substatus || 'Waiting for the model…';
        step.error = '';
        step.text = '';
        step.thinking = '';
        step.finishReason = '';

        if (settings.expandRunningSteps !== false) {
            step.open = true;
        }

        const live = document.createElement('div');
        live.className = 'cb-markdown cb-streaming';
        const pre = document.createElement('pre');
        pre.className = 'cb-stream-raw';
        const code = document.createElement('code');
        pre.appendChild(code);
        live.appendChild(pre);
        step.liveElement = live;

        const liveThinking = document.createElement('pre');
        liveThinking.className = 'cb-pre cb-thinking-pre';
        const thinkingCode = document.createElement('code');
        liveThinking.appendChild(thinkingCode);
        step.liveThinkingElement = liveThinking;

        let rendered = '';
        let thinking = '';
        let lastRender = 0;
        const scheduleRender = (text, isThinking) => {
            const now = Date.now();
            step.elapsedMs = now - step.startedAt;
            const elapsedSec = step.elapsedMs / 1000;
            const totalChars = (rendered ? rendered.length : 0) + (thinking ? thinking.length : 0);
            if (elapsedSec > 0 && totalChars) {
                step.tokenCount = Math.round(totalChars / 3.8);
                step.tokensPerSec = Math.round(step.tokenCount / elapsedSec);
            }
            if (now - lastRender < 80) return;
            lastRender = now;
            if (step.liveThinkingElement && thinkingCode) {
                thinkingCode.textContent = thinking;
                if (liveThinking.scrollHeight - liveThinking.scrollTop - liveThinking.clientHeight < 60) {
                    liveThinking.scrollTop = liveThinking.scrollHeight;
                }
            }
            code.textContent = text;
            if (hooks && typeof hooks.onStream === 'function') hooks.onStream(step, text);
        };

        if (hooks && typeof hooks.onRender === 'function') hooks.onRender();

        try {
            let result = await core.streamModelTurn({
                systemPrompt: options.systemPrompt,
                message: options.prompt,
                maxOutputTokens: options.maxOutputTokens,
                temperature: options.temperature,
                signal: options.signal,
                cancelId: options.cancelId,
                onDelta: (_delta, fullText) => {
                    rendered = fullText;
                    step.substatus = 'Streaming response…';
                    scheduleRender(fullText, false);
                },
                onThinking: (_delta, fullThinking) => {
                    thinking = fullThinking;
                    step.thinking = bounded(fullThinking);
                    step.substatus = 'Reasoning & planning…';
                    scheduleRender(rendered, true);
                }
            });

            let accumulatedText = (core && typeof core.stripOutputLimitNotice === 'function')
                ? core.stripOutputLimitNotice(result.text || rendered)
                : String(result.text || rendered || '').replace(/\[⚠️\s*(?:Context window|Output|Response length) limit reached[^\]]*\]/gi, '').trim();
            let accumulatedThinking = result.thinking || thinking;
            let finishReason = result.finishReason || '';
            let totalUsage = result.usage ? { ...result.usage } : null;
            let continuationPass = 0;
            const MAX_CONTINUATION_PASSES = 4;

            const checkLimitReached = (resText, reason) => {
                if (reason === 'length') return true;
                if (core && typeof core.hasOutputLimitNotice === 'function') {
                    return core.hasOutputLimitNotice(resText);
                }
                return /(?:Context window|Output|Response length) limit reached/i.test(String(resText || ''));
            };

            while (checkLimitReached(result.text || rendered, finishReason) && continuationPass < MAX_CONTINUATION_PASSES) {
                if (options.signal && options.signal.aborted) break;
                continuationPass++;
                step.substatus = `⚡ Output limit reached — automatically continuing generation (part ${continuationPass + 1})…`;
                scheduleRender(accumulatedText, false);
                if (hooks && typeof hooks.onRender === 'function') hooks.onRender();

                const contPrompt = buildContinuationPrompt(options.prompt, accumulatedText);
                let contRendered = '';

                const contResult = await core.streamModelTurn({
                    systemPrompt: options.systemPrompt,
                    message: contPrompt,
                    maxOutputTokens: options.maxOutputTokens,
                    temperature: options.temperature,
                    signal: options.signal,
                    cancelId: options.cancelId,
                    onDelta: (_delta, fullContText) => {
                        contRendered = fullContText;
                        const stitchedLive = stitchContinuationText(accumulatedText, fullContText);
                        scheduleRender(stitchedLive, false);
                    },
                    onThinking: (_delta, fullContThinking) => {
                        const stitchedLive = stitchContinuationText(accumulatedText, contRendered);
                        scheduleRender(stitchedLive, true);
                    }
                });

                const cleanChunk = (core && typeof core.stripOutputLimitNotice === 'function')
                    ? core.stripOutputLimitNotice(contResult.text || contRendered)
                    : String(contResult.text || contRendered || '').replace(/\[⚠️\s*(?:Context window|Output|Response length) limit reached[^\]]*\]/gi, '').trim();
                accumulatedText = stitchContinuationText(accumulatedText, cleanChunk);
                finishReason = contResult.finishReason || '';
                result = contResult;
                rendered = contRendered;

                if (contResult.usage && totalUsage) {
                    totalUsage.prompt_tokens = (totalUsage.prompt_tokens || 0) + (contResult.usage.prompt_tokens || 0);
                    totalUsage.completion_tokens = (totalUsage.completion_tokens || 0) + (contResult.usage.completion_tokens || 0);
                    totalUsage.total_tokens = (totalUsage.total_tokens || 0) + (contResult.usage.total_tokens || 0);
                }
            }

            if (continuationPass > 0 && !checkLimitReached(result.text || rendered, finishReason)) {
                finishReason = 'stop';
            }

            step.cancelId = result.cancelId || '';
            step.text = bounded(accumulatedText);
            step.thinking = bounded(accumulatedThinking);
            step.finishReason = finishReason;
            if (totalUsage) step.usage = totalUsage;
            finishStep(step, 'done');
            step.open = true;
            return step;
        } catch (error) {
            if (error && error.code === 'aborted') {
                step.text = bounded(rendered);
                step.thinking = bounded(thinking);
                finishStep(step, 'error');
                step.error = 'Stopped by the user.';
                throw error;
            }

            // Auto-compaction recovery: when context runs out, compact automatically and retry the turn
            const isOverflow = (core && typeof core.isContextOverflowError === 'function')
                ? core.isContextOverflowError(error)
                : String(error && (error.message || error)).toLowerCase().includes('context');

            if (isOverflow && !options._retriedWithCompaction) {
                if (hooks && typeof hooks.onAutoCompact === 'function') {
                    step.substatus = '⚡ Context limit reached — auto-compacting and retrying…';
                    step.error = '';
                    try {
                        const newCompaction = await hooks.onAutoCompact({
                            error,
                            step,
                            options,
                            reason: 'context-overflow'
                        });
                        if (newCompaction) {
                            options._retriedWithCompaction = true;
                            options.prompt = injectCompactionIntoPrompt(options.prompt, newCompaction);
                            step.promptPreview = promptPreview(options.prompt, settings.maxPromptChars);
                            step.text = '';
                            step.thinking = '';
                            return await runModelStep(step, options, hooks);
                        }
                    } catch (compactError) {
                        console.warn('[Blueprint] Auto-compaction recovery failed:', compactError);
                    }
                }
            }

            finishStep(step, 'error');
            step.error = String((error && error.message) || 'The model step failed.');
            step.text = bounded(rendered);
            step.thinking = bounded(thinking);
            throw error;
        }
    }

    // ------------------------------------------------------------------
    // Anti-gravity Context Compression Protocol
    // ------------------------------------------------------------------

    function stripCompactionFromPrompt(prompt) {
        const text = String(prompt || '');
        const marker = '# Resuming from a compaction';
        if (!text.startsWith(marker)) return text;
        const separator = '\n\n---\n\n';
        const sepIndex = text.indexOf(separator);
        if (sepIndex !== -1) {
            return text.slice(sepIndex + separator.length).trimStart();
        }
        return text;
    }

    function formatCompactionPrompt(compaction) {
        if (!compaction || !compaction.rawText) return '';
        return String(compaction.rawText).trim();
    }

    function injectCompactionIntoPrompt(prompt, compaction) {
        if (!compaction || !compaction.rawText) return prompt;
        const formatted = formatCompactionPrompt(compaction);
        if (!formatted) return prompt;
        const cleanPrompt = stripCompactionFromPrompt(prompt);
        return `${formatted}\n\n---\n\n${cleanPrompt}`;
    }

    /**
     * Anti-gravity Context Compactor
     *
     * Synthesizes a dense, structured compaction adhering strictly to the Anti-gravity
     * schema. Attempts a model turn if an endpoint is active, or relies deterministically
     * on core.buildDeterministicCompaction.
     */
    async function compressContext(options) {
        const opts = options || {};
        const messages = Array.isArray(opts.messages) ? opts.messages : [];
        const run = opts.run || null;
        const settings = opts.settings || core.readSettings();
        const activeFolder = opts.activeFolder || (core && core.activeFolder && core.activeFolder());
        const signal = opts.signal;

        const deterministic = core.buildDeterministicCompaction({
            messages,
            run,
            activeFolder,
            settings
        });

        if (!opts.useModel || !core.streamModelTurn || typeof core.streamModelTurn !== 'function') {
            return deterministic;
        }

        try {
            const compactorPrompt = [
                'Compress the following user requests, agent execution steps, and planning history into a structured Anti-gravity compaction block.',
                '',
                'Follow this exact schema:',
                '### 1. Task Overview',
                '### 2. Progress',
                '### 3. Key Findings & Decisions',
                '### 4. Active Context',
                '### 5. Next Steps',
                '### 6. Commitments & Constraints',
                '',
                '## Raw History & User Requests:',
                deterministic.userRequests.map((r, i) => `${i + 1}. ${r}`).join('\n'),
                '',
                '## Completed Artifacts & Details:',
                deterministic.summary
            ].join('\n');

            let modelOutput = '';
            await core.streamModelTurn({
                systemPrompt: 'You are the Anti-gravity Context Compactor. Compress the conversation history into the Anti-gravity structured schema. Retain all user requests, decisions, and constraints. Return only the markdown sections.',
                message: compactorPrompt,
                maxOutputTokens: 2048,
                temperature: 0.2,
                signal
            }, {
                onDelta: (_d, full) => { modelOutput = full; }
            });

            if (modelOutput && modelOutput.includes('### 1. Task Overview')) {
                const refinedSummary = modelOutput.trim();
                const rawCompaction = [
                    '# Resuming from a compaction',
                    '',
                    'You are continuing work on the task described above, but you have lost access to the full conversation history, and need to resume work efficiently using the progress summary below:',
                    '',
                    '# User Requests',
                    'The following were user requests from the truncated conversation in chronological order:',
                    deterministic.userRequests.map((req, idx) => `${idx + 1}. ${req}`).join('\n'),
                    '',
                    '<summary>',
                    refinedSummary,
                    '</summary>'
                ].join('\n');

                const originalTokens = deterministic.originalTokens;
                const compactedTokens = Math.max(1, Math.round(rawCompaction.length / 3.8));
                const savedTokens = Math.max(0, originalTokens - compactedTokens);
                const savedPercent = originalTokens > 0 ? Math.min(95, Math.max(0, Math.round((savedTokens / originalTokens) * 100))) : 0;

                return Object.assign({}, deterministic, {
                    summary: refinedSummary,
                    rawText: rawCompaction,
                    compactedTokens,
                    savedTokens,
                    savedPercent
                });
            }
        } catch (error) {
            console.warn('[codalio-blueprint] model-assisted compaction deferred to deterministic engine', error);
        }

        return deterministic;
    }

    /**
     * Collect the existing project documents a skill wants to read (e.g. a PRD
     * for doc-generation), newest first per folder.
     */
    function collectExistingDocs(folders) {
        const wanted = Array.isArray(folders) ? folders : [];
        const found = {};
        if (!wanted.length) return found;
        const paths = core.listFiles();
        wanted.forEach(folder => {
            const prefix = `${folder}/`;
            const matches = paths
                .filter(path => path.startsWith(prefix))
                .sort((left, right) => {
                    const leftRecord = core.readFile(left);
                    const rightRecord = core.readFile(right);
                    return String(rightRecord && rightRecord.updatedAt).localeCompare(String(leftRecord && leftRecord.updatedAt));
                });
            if (matches.length) {
                const record = core.readFile(matches[0]);
                found[folder] = record ? record.content : '';
                found[`${folder}#path`] = matches[0];
            }
        });
        return found;
    }

    /**
     * Select the attached source files that go into a prompt, honouring the
     * limits from Settings -> Source files.
     *
     * Previously this compared against core.MAX_SOURCE_TOTAL_BYTES, which core
     * never exported — so `total + bytes > undefined` was always false and the
     * limit never applied. The caps are now read from settings, and a per-file
     * cap is enforced too so one huge file cannot crowd out the rest.
     */
    function sourceFilesForModel(projectState, settings) {
        const cfg = settings || core.readSettings();
        if (cfg.includeSourceInPrompts === false) return [];

        const maxFiles = Number(cfg.maxSourceFiles) || 50;
        const maxFileBytes = (Number(cfg.maxSourceFileKb) || 500) * 1024;
        const maxTotalBytes = (Number(cfg.maxSourceTotalKb) || 2048) * 1024;

        let total = 0;
        const selected = [];
        const rejected = [];

        const mode = projectState.sourceFileMode || '';
        const attached = Array.isArray(projectState.sourceFiles) ? projectState.sourceFiles.filter(Boolean) : [];

        // 1. Process user-selected / attached files first
        if (attached.length) {
            for (const file of attached) {
                if (!file || typeof file.content !== 'string') continue;
                if (selected.length >= maxFiles) {
                    rejected.push({ path: file.path, reason: 'over the maximum file count' });
                    continue;
                }
                const bytes = file.content.length;
                if (bytes > maxFileBytes) {
                    rejected.push({ path: file.path, reason: `larger than ${Math.round(maxFileBytes / 1024)} KB` });
                    continue;
                }
                if (total + bytes > maxTotalBytes) {
                    rejected.push({ path: file.path, reason: 'would exceed the total size budget' });
                    continue;
                }
                total += bytes;
                selected.push({
                    path: file.path,
                    content: file.content,
                    lines: file.content.split('\n').length
                });
            }
        }

        // 2. Auto-discovery from project workspace to fill budget:
        // - In 'combine' mode: augments manually attached files with auto-discovered workspace files.
        // - In 'exclusive' mode: strictly limited to attached files only.
        // - When unspecified: auto-discovers only when no files were manually attached (backward-compat).
        const shouldDiscover = mode === 'combine' || (!mode && !attached.length);
        if (shouldDiscover && core && typeof core.listFiles === 'function') {
            // Standalone Direct Project Access:
            // Lazily inspect files directly, stopping as soon as budget is filled.
            const activeFolderId = projectState.activeFolderId || (core.store && core.store.activeFolderId);
            const folderFiles = core.listFiles(activeFolderId);
            const targetFiles = folderFiles.length ? folderFiles : core.listFiles();

            // Filter out generated docs, prioritize source code and project configs
            const sourcePaths = targetFiles.filter(p => !p.startsWith('docs/'));
            const finalPaths = sourcePaths.length ? sourcePaths : targetFiles;

            for (const path of finalPaths) {
                // Skip if already attached by the user
                if (selected.some(item => item.path === path)) continue;

                if (selected.length >= maxFiles) {
                    rejected.push({ path, reason: 'over the maximum file count' });
                    break; // stop reading any more files from storage!
                }
                const rec = core.readFile(path);
                if (!rec || typeof rec.content !== 'string') continue;
                const bytes = rec.content.length;
                if (bytes > maxFileBytes) {
                    rejected.push({ path, reason: `larger than ${Math.round(maxFileBytes / 1024)} KB` });
                    continue;
                }
                if (total + bytes > maxTotalBytes) {
                    rejected.push({ path, reason: 'would exceed the total size budget' });
                    break; // stop reading once size budget is hit!
                }
                total += bytes;
                selected.push({
                    path: rec.path,
                    content: rec.content,
                    lines: rec.content.split('\n').length
                });
            }
        }

        selected.rejected = rejected;
        selected.totalBytes = total;
        return selected;
    }

    function resolveProjectName(skill, input, run) {
        const derived = typeof skill.projectNameFrom === 'function' ? skill.projectNameFrom(input) : '';
        const name = String(derived || run.projectName || '').trim().slice(0, 80);
        if (name) return name;
        const idea = String(input.idea || '').trim();
        const words = idea.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
        return words ? words.replace(/[^\w\s-]/g, '').trim() || 'Untitled project' : 'Untitled project';
    }

    /**
     * Resolve the output path, honouring Settings -> Documents -> Naming &
     * folders. A skill's own outputFileName wins when it declares one, since the
     * upstream naming is part of the skill contract; otherwise the configured
     * date/slug style and folder layout apply.
     */
    function outputPathFor(skill, phase, meta, settings) {
        const cfg = settings || core.readSettings();
        const declaresOwnName = (phase && phase.optional && skill.outputFileNames && skill.outputFileNames[phase.optional])
            || (!phase && typeof skill.outputFileName === 'function');

        if (declaresOwnName) {
            const folder = phase && phase.optional && skill.perPhaseOutput
                ? ((skill.outputFolders || {})[phase.optional] || skill.outputFolder || 'docs')
                : (skill.outputFolder || 'docs');
            const nameFn = phase && phase.optional
                ? (skill.outputFileNames || {})[phase.optional]
                : skill.outputFileName;
            const fileName = typeof nameFn === 'function' ? String(nameFn(meta) || '') : '';
            const path = fileName ? core.joinPath(folder, fileName) : core.buildOutputPath(skill, phase, meta, cfg);
            return core.withCollisionHandling(path, cfg);
        }
        return core.buildOutputPath(skill, phase, meta, cfg);
    }

    /**
     * Apply the deterministic cleanup pipeline before writing. Delegates to
     * core.prepareDocument so the switches in Settings -> Documents -> Content
     * handling (unwrap fences, trim preamble, substitute placeholders, add a
     * provenance header) are the single source of truth.
     */
    function applyDocumentHeader(document, meta, sourcePrdPath, settings, skillName) {
        return core.prepareDocument(document, {
            date: meta && meta.date,
            projectName: meta && meta.projectName,
            sourcePrdPath: sourcePrdPath || '',
            skillName: skillName || ''
        }, settings);
    }

    /**
     * The self-review pass: a REAL structural check over the document that was
     * just written, against the sections the skill's own template demanded.
     *
     * Reports missing sections, leftover template placeholders, and sections
     * that are present but too thin to be useful. Costs no model turn.
     */
    function reviewDocument(content, requiredSections) {
        const body = String(content || '');
        const wanted = Array.isArray(requiredSections) ? requiredSections : [];
        const headings = [];
        const headingPattern = /^#{1,6}\s+(.+?)\s*$/gm;
        let match = null;
        while ((match = headingPattern.exec(body)) !== null) {
            headings.push(match[1].replace(/^[\d.]+\s*/, '').trim().toLowerCase());
        }

        const missing = [];
        const present = [];
        wanted.forEach(section => {
            const needle = String(section).toLowerCase();
            const found = headings.some(heading => heading === needle || heading.includes(needle));
            if (found) present.push(section);
            else missing.push(section);
        });

        // Leftover template placeholders mean the model echoed the contract
        // instead of filling it in.
        const placeholders = [];
        const placeholderPattern = /<[^>\n]{2,60}>/g;
        let token = null;
        while ((token = placeholderPattern.exec(body)) !== null) {
            const value = token[0];
            if (value.includes('\n')) continue;
            if (!placeholders.includes(value)) placeholders.push(value);
            if (placeholders.length >= 12) break;
        }

        // A section with almost no content under it is thin.
        const thin = [];
        const blocks = body.split(/^#{1,6}\s+/m).slice(1);
        blocks.forEach(block => {
            const newline = block.indexOf('\n');
            const title = (newline > 0 ? block.slice(0, newline) : block).replace(/^[\d.]+\s*/, '').trim();
            const content = newline > 0 ? block.slice(newline + 1) : '';
            const words = content.split(/\s+/).filter(Boolean).length;
            if (words > 0 && words < 12) thin.push(`${title} (${words} words)`);
        });

        return {
            headings: headings.length,
            words: body.split(/\s+/).filter(Boolean).length,
            present,
            missing,
            placeholders,
            thin,
            ok: missing.length === 0 && placeholders.length === 0
        };
    }

    /**
     * Ask the skill's clarifying questions as visible steps, in the order the
     * source skill defines them. Each question becomes a step the user can read
     * and answer; nothing runs until it is answered or the run is stopped.
     *
     * hooks.askQuestion(step) resolves with the user's answer, or null when the
     * run was stopped. Returning null aborts the whole run.
     */
    async function askClarifyingQuestions(run, skill, emit, render, hooks, signal) {
        const answers = [];
        if (!core.readSettings().askClarifyingQuestions) {
            emit(makeStep({
                kind: 'notice',
                label: 'Clarifying questions skipped',
                summary: 'Turned off in Blueprint settings',
                status: 'skipped',
                text: 'Blueprint went straight to the lenses using only the idea you described. Turn clarifying questions back on in Settings for a tighter result.',
                open: false
            }));
            render();
            return answers;
        }

        const questions = Array.isArray(skill.clarifying) ? skill.clarifying : [];
        for (const question of questions) {
            if (signal && signal.aborted) return null;
            const step = makeStep({
                kind: 'question',
                label: `Clarifying question — ${question.id}`,
                summary: question.question,
                question: question.question,
                options: question.multi || [],
                status: 'running',
                open: true
            });
            emit(step);
            render();

            const answer = hooks && typeof hooks.askQuestion === 'function'
                ? await hooks.askQuestion(step, question)
                : null;

            if (answer === null || answer === undefined) {
                step.status = 'error';
                step.error = 'Stopped before this question was answered.';
                step.open = false;
                core.saveRun(run);
                render();
                return null;
            }

            step.answered = String(answer);
            step.status = 'done';
            step.open = false;
            core.saveRun(run);
            answers.push({ id: question.id, question: question.question, answer: String(answer) });
            render();
        }
        return answers;
    }

    /**
     * Run a skill to completion, emitting steps into run.phases as it goes.
     *
     * hooks:
     *   onRender()            re-render the page after state changed
     *   onStep(step)          a step was added or finished
     *   onStream(step, text)  live model output arrived
     *   askQuestion(step, q)  resolve with the user's answer, or null to stop
     */
    async function runSkill(run, skill, input, hooks) {
        const settings = core.readSettings();
        run.pipeline = [
            { id: 'plan', label: 'Plan & Scope', status: 'running' },
            { id: 'lenses', label: skill.multiLens ? 'Analytical Lenses' : 'Analysis', status: 'pending' },
            { id: 'synthesis', label: 'Synthesis', status: 'pending' },
            { id: 'review', label: 'Quality Check', status: 'pending' },
            { id: 'artifacts', label: 'Artifacts', status: 'pending' }
        ];
        const updatePipeline = (id, status) => {
            if (Array.isArray(run.pipeline)) {
                const item = run.pipeline.find(p => p.id === id);
                if (item) item.status = status;
                core.saveRun(run);
            }
        };

        const emit = step => {
            run.phases.push(step);
            if (hooks && typeof hooks.onStep === 'function') {
                try { hooks.onStep(step); } catch (err) { console.warn('[Blueprint] onStep hook error:', err); }
            }
            core.saveRun(run);
        };
        const render = () => {
            if (hooks && typeof hooks.onRender === 'function') {
                try { hooks.onRender(); } catch (err) { console.warn('[Blueprint] onRender hook error:', err); }
            }
        };

        // ---- Announce ------------------------------------------------
        // Settings -> Agent -> Planning -> "Announce the chosen skill".
        if (settings.announceSkill !== false) {
            const announce = makeStep({
                kind: 'notice',
                label: skill.announce,
                summary: skill.tagline,
                status: 'done',
                text: skill.description,
                open: false
            });
            emit(announce);
            render();
        }

        // ---- Project identity ---------------------------------------
        run.projectName = resolveProjectName(skill, input, run);
        run.slug = core.slugify(run.projectName);
        core.saveRun(run);

        const meta = {
            date: core.todayStamp(),
            slug: run.slug,
            projectName: run.projectName
        };

        const compaction = input.compaction || (run && run.compaction) || null;

        // ---- Clarifying questions (one at a time, as visible steps) ----
        const answers = await askClarifyingQuestions(
            run,
            skill,
            emit,
            render,
            hooks || {},
            input.signal
        );
        if (answers === null) {
            const stopped = new core.BlueprintAbort('Stopped during the clarifying questions.');
            throw stopped;
        }
        input.answers = answers;

        // ---- Source requirement gate --------------------------------
        if (skill.requiresSource) {
            const attached = sourceFilesForModel(input, settings);
            if (!attached.length) {
                const blocked = makeStep({
                    kind: 'notice',
                    label: 'Waiting for source',
                    summary: skill.name + ' must read the actual code',
                    status: 'error',
                    text: skill.sourceHint,
                    open: true,
                    error: 'No source attached. Add the files you want evaluated, then run this skill again.'
                });
                emit(blocked);
                render();
                const failure = new core.BlueprintAbort('waiting-for-source');
                failure.code = 'waiting-for-source';
                throw failure;
            }
            input.sourceFiles = attached;
            const summaryPaths = attached.map(file => file.path);
            const summaryText = summaryPaths.slice(0, 6).join(', ') + (summaryPaths.length > 6 ? ` (+${summaryPaths.length - 6} more)` : '');
            const listed = makeStep({
                kind: 'notice',
                label: `Reading ${attached.length} project source file${attached.length === 1 ? '' : 's'}`,
                summary: summaryText,
                status: 'done',
                text: attached.map(file => `- \`${file.path}\` — ${file.lines} lines (read-only)`).join('\n'),
                open: false
            });
            emit(listed);
            render();
        }

        // ---- Existing docs the skill reads --------------------------
        if (skill.readsExistingDocs && skill.readsExistingDocs.length) {
            input.existingDocs = collectExistingDocs(skill.readsExistingDocs);
            const prdPath = input.existingDocs['docs/prd#path'];
            if (skill.requiresPrd && !input.existingDocs['docs/prd']) {
                const blocked = makeStep({
                    kind: 'notice',
                    label: 'No PRD in this project',
                    summary: 'doc-generation needs an existing PRD to work from',
                    status: 'error',
                    text: 'Run **PRD Builder** first, or add an existing PRD at `docs/prd/<name>.md` in the project tree. This skill deliberately does not improvise a PRD.',
                    open: true,
                    error: 'No document found under docs/prd/.'
                });
                emit(blocked);
                render();
                const failure = new core.BlueprintAbort('missing-prd');
                failure.code = 'missing-prd';
                throw failure;
            }
            if (prdPath) {
                const found = makeStep({
                    kind: 'notice',
                    label: `Found source PRD: ${prdPath}`,
                    summary: 'Reusing its target user, scope, and entities instead of re-asking',
                    status: 'done',
                    open: false
                });
                emit(found);
                render();
                input.sourcePrdPath = prdPath;
            }
        }

        const handleAutoCompact = async (event) => {
            if (hooks && typeof hooks.onAutoCompact === 'function') {
                const updated = await hooks.onAutoCompact(event);
                if (updated) {
                    compaction = updated;
                    input.compaction = updated;
                    return updated;
                }
            }
            const fallback = core.buildDeterministicCompaction({
                messages: input.messages || [],
                run,
                settings
            });
            compaction = fallback;
            input.compaction = fallback;
            return fallback;
        };

        // ---- Lenses (multi-lens skills) -----------------------------
        const lensOutputs = {};
        if (skill.multiLens && Array.isArray(skill.lenses) && skill.lenses.length) {
            updatePipeline('plan', 'done');
            updatePipeline('lenses', 'running');
            const planNote = makeStep({
                kind: 'notice',
                label: settings.concurrency === 'parallel'
                    ? `Running ${skill.lenses.length} lenses concurrently`
                    : `Running ${skill.lenses.length} lenses one after another`,
                summary: 'Each lens is a separate model turn with its own output contract',
                status: 'done',
                text: 'The three lenses are independent — none needs another\u2019s output to run. Either way they produce the same three write-ups before synthesis. If you can tell from the final document which lens produced which paragraph, synthesis did not do its job.',
                open: false
            });
            emit(planNote);
            render();

            const lensSteps = skill.lenses.map(lens => makeStep({
                kind: 'lens',
                label: lens.label,
                summary: lens.summary,
                icon: lens.icon,
                lensId: lens.id
            }));
            lensSteps.forEach(step => { run.phases.push(step); });
            core.saveRun(run);
            render();

            const runLens = async (lens, step) => {
                const rawPrompt = lens.buildPrompt({
                    idea: input.idea,
                    answers: input.answers,
                    requirementsText: input.requirementsText
                });
                const prompt = injectCompactionIntoPrompt(rawPrompt, compaction);
                await runModelStep(step, {
                    prompt,
                    substatus: `Analyzing ${lens.label}…`,
                    systemPrompt: systemPromptWith(
                        'You are a product planning analyst. Follow the output contract exactly and return only the requested Markdown sections.',
                        settings
                    ),
                    maxOutputTokens: settings.lensMaxOutputTokens,
                    temperature: settings.temperature,
                    signal: input.signal
                }, {
                    onRender: render,
                    onStream: (s, t) => { if (hooks && typeof hooks.onStream === 'function') hooks.onStream(s, t); },
                    onAutoCompact: handleAutoCompact
                });
                lensOutputs[lens.id] = step.text;
                core.saveRun(run);
            };

            if (settings.concurrency === 'parallel') {
                await Promise.all(skill.lenses.map((lens, index) => runLens(lens, lensSteps[index])));
            } else {
                for (let index = 0; index < skill.lenses.length; index += 1) {
                    await runLens(skill.lenses[index], lensSteps[index]);
                    render();
                }
            }
            input.lensOutputs = lensOutputs;
            updatePipeline('lenses', 'done');
            render();
        } else {
            updatePipeline('plan', 'done');
        }

        // ---- Phases --------------------------------------------------
        updatePipeline('synthesis', 'running');
        const phaseOutputs = {};
        const writtenPaths = [];
        // path + the phase that produced it, so the self-review can look up the
        // phase's requiredSections even when collision handling bumped the path.
        const writtenDocs = [];
        const phases = Array.isArray(skill.phases) ? skill.phases : [];
        const selectedOptions = Array.isArray(input.selectedOptions) ? input.selectedOptions : null;

        for (const phase of phases) {
            if (phase.optional && selectedOptions && !selectedOptions.includes(phase.optional)) {
                const skipped = makeStep({
                    kind: 'notice',
                    label: `Skipped: ${phase.label}`,
                    summary: 'Not selected for this run',
                    status: 'skipped',
                    open: false
                });
                emit(skipped);
                render();
                continue;
            }

            const isDoc = phase.kind === 'document';
            const isLargeStep = isDoc || phase.kind === 'analysis' || Boolean(phase.requiresSource || skill.requiresSource);
            const phaseTokenBudget = isLargeStep ? settings.documentMaxOutputTokens : settings.lensMaxOutputTokens;
            const step = makeStep({
                kind: isDoc ? 'document' : 'phase',
                label: phase.label,
                summary: phase.summary,
                icon: phase.icon
            });
            emit(step);
            render();

            const rawPrompt = phase.buildPrompt({
                idea: input.idea,
                answers: input.answers,
                requirementsText: input.requirementsText,
                lensOutputs,
                phaseOutputs,
                existingDocs: input.existingDocs,
                sourceFiles: input.sourceFiles
            });
            const prompt = injectCompactionIntoPrompt(rawPrompt, compaction);

            await runModelStep(step, {
                prompt,
                substatus: isDoc ? 'Synthesizing unified document…' : `Executing ${phase.label}…`,
                systemPrompt: systemPromptWith(
                    'You are a product planning analyst. Follow the output contract exactly. Return only the requested Markdown, with no preamble.',
                    settings
                ),
                maxOutputTokens: phaseTokenBudget,
                temperature: settings.temperature,
                signal: input.signal
            }, {
                onRender: render,
                onStream: (s, t) => { if (hooks && typeof hooks.onStream === 'function') hooks.onStream(s, t); },
                onAutoCompact: handleAutoCompact
            });

            phaseOutputs[phase.id] = step.text;

            if (phase.kind === 'document') {
                const path = outputPathFor(skill, phase, meta, settings);
                const content = applyDocumentHeader(
                    step.text,
                    meta,
                    input.sourcePrdPath,
                    settings,
                    skill.name
                );
                const record = core.writeFile(path, content, { runId: run.id, skill: skill.id });
                writtenPaths.push(path);
                writtenDocs.push({ path, phase });
                run.writtenPaths = writtenPaths.slice();

                const writeStep = makeStep({
                    kind: 'notice',
                    label: `Wrote ${path}`,
                    summary: record ? `${record.content.length.toLocaleString()} characters` : '',
                    status: 'done',
                    text: `Saved to the Blueprint project at \`${path}\`. Review it before treating it as final — nothing here is written to your SimpleRAG workspace.`,
                    open: false
                });
                emit(writeStep);

                // Let the page open (or refresh) an editor tab for this file.
                if (hooks && typeof hooks.onFileWritten === 'function') {
                    try { hooks.onFileWritten(path); } catch (_) { /* UI hook failed; the run continues */ }
                }
                if (settings.autoOpenWrittenDocument) core.setOpenPath(path);
                render();
            }
            core.saveRun(run);
        }

        // ---- Self-review ---------------------------------------------
        updatePipeline('synthesis', 'done');
        updatePipeline('review', 'running');
        // A genuine structural check over what was actually written, against the
        // sections this skill's own template demanded. No model turn is spent on
        // it. Controlled by Settings -> Agent -> Planning -> Self-review pass.
        const reviews = [];
        if (writtenPaths.length && settings.selfReviewPass !== false) {
            writtenDocs.forEach(doc => {
                const record = core.readFile(doc.path);
                if (!record) return;
                // Use the phase recorded at write time: collision handling may
                // have bumped the final path, so re-deriving it can fail to match.
                const phase = doc.phase || null;
                const required = (phase && Array.isArray(phase.requiredSections))
                    ? phase.requiredSections
                    : (Array.isArray(skill.requiredSections) ? skill.requiredSections : []);
                const result = reviewDocument(record.content, required);
                reviews.push({ path: doc.path, required, result });
            });

            reviews.forEach(review => {
                const lines = [];
                lines.push(`Checked \`${review.path}\` against the ${review.required.length} section${review.required.length === 1 ? '' : 's'} this skill's template requires.`);
                lines.push('');
                lines.push(`- Headings found: **${review.result.headings}**`);
                lines.push(`- Words: **${review.result.words.toLocaleString()}**`);
                lines.push(`- Required sections present: **${review.result.present.length}/${review.required.length}**`);

                if (review.result.missing.length) {
                    lines.push('');
                    lines.push('**Missing sections:**');
                    review.result.missing.forEach(section => { lines.push(`- ${section}`); });
                }
                if (review.result.placeholders.length) {
                    lines.push('');
                    lines.push('**Leftover template placeholders** (the contract was echoed instead of filled in):');
                    review.result.placeholders.forEach(placeholder => { lines.push(`- \`${placeholder}\``); });
                }
                if (review.result.thin.length) {
                    lines.push('');
                    lines.push('**Sections thinner than 12 words** (likely need real content):');
                    review.result.thin.forEach(entry => { lines.push(`- ${entry}`); });
                }
                if (review.result.ok && !review.result.thin.length) {
                    lines.push('');
                    lines.push('No missing sections and no leftover placeholders.');
                }

                const step = makeStep({
                    kind: 'notice',
                    label: review.result.ok
                        ? `Self-review passed — ${review.path.split('/').pop()}`
                        : `Self-review found gaps — ${review.path.split('/').pop()}`,
                    summary: review.result.ok
                        ? `${review.result.present.length}/${review.required.length} required sections present`
                        : `${review.result.missing.length} missing · ${review.result.placeholders.length} placeholder${review.result.placeholders.length === 1 ? '' : 's'} left`,
                    status: review.result.ok ? 'done' : 'error',
                    text: lines.join('\n'),
                    open: !review.result.ok,
                    error: review.result.ok ? '' : 'The document is incomplete against its own template. Ask for a revision, or raise the document token budget if the run hit its output limit.'
                });
                emit(step);
                render();
            });
        }
        updatePipeline('review', 'done');
        updatePipeline('artifacts', 'done');

        // ---- User review gate ------------------------------------------
        // Settings -> Agent -> Planning -> "End on a review gate".
        if (writtenPaths.length && settings.requireReviewGate !== false) {
            const failed = reviews.filter(review => !review.result.ok);
            const review = makeStep({
                kind: 'notice',
                label: 'Your review gate',
                summary: `${writtenPaths.length} document${writtenPaths.length === 1 ? '' : 's'} written`
                    + (failed.length ? ` · ${failed.length} with gaps` : ''),
                status: 'done',
                text: [
                    `**Where the file${writtenPaths.length === 1 ? ' is' : 's are'}:**`,
                    ...writtenPaths.map(path => `- \`${path}\``),
                    '',
                    failed.length
                        ? 'The self-review above flagged gaps. Read those before treating this as final.'
                        : 'Blueprint wrote these to its own project store — nothing was added to your SimpleRAG workspace.',
                    '',
                    'Tell me what to change and I will revise the document in place.'
                ].join('\n'),
                open: true
            });
            emit(review);
        }

        const reviewFailed = reviews.some(review => !review.result.ok);
        run.status = reviewFailed ? 'gaps' : 'done';
        run.writtenPaths = writtenPaths.slice();
        run.reviews = reviews.map(review => ({
            path: review.path,
            ok: review.result.ok,
            missing: review.result.missing,
            placeholders: review.result.placeholders,
            thin: review.result.thin
        }));
        core.saveRun(run);
        render();
        return { writtenPaths, meta, reviews };
    }

    /**
     * Autonomous gap repair pass: directly addresses missing sections flagged in review.
     */
    async function reviseDocumentGaps(run, targetPath, gaps, hooks, options) {
        const settings = (options && options.settings) || core.readSettings();
        const existing = core.readFile(targetPath);
        if (!existing) throw new Error(`Target document ${targetPath} not found`);

        const step = makeStep({
            kind: 'document',
            label: `Autonomous Gap Repair — ${targetPath.split('/').pop()}`,
            summary: `Addressing ${((gaps && gaps.missing) || []).length} missing sections and placeholders`,
            status: 'running',
            open: true,
            substatus: 'Drafting missing sections…'
        });
        run.phases.push(step);
        if (hooks && typeof hooks.onStep === 'function') {
            try { hooks.onStep(step); } catch (err) { console.warn('[Blueprint] onStep hook error in gap repair:', err); }
        }
        core.saveRun(run);
        if (hooks && typeof hooks.onRender === 'function') {
            try { hooks.onRender(); } catch (err) { console.warn('[Blueprint] onRender hook error in gap repair:', err); }
        }

        const missingText = (gaps && gaps.missing && gaps.missing.length)
            ? `- Missing sections: ${gaps.missing.join(', ')}`
            : '';
        const placeholderText = (gaps && gaps.placeholders && gaps.placeholders.length)
            ? `- Placeholders to replace: ${gaps.placeholders.join(', ')}`
            : '';

        const prompt = [
            'You are a senior product analyst and technical architect revising a document that had incomplete sections.',
            '',
            `Document: ${targetPath}`,
            '',
            '## Identified Gaps to Repair',
            missingText,
            placeholderText,
            '',
            '## Existing Content',
            existing.content,
            '',
            'Task: Return the COMPLETE revised Markdown document with all missing sections fully written and placeholders completed.',
            'Output contract: Return only the full revised Markdown document. No preamble.'
        ].filter(Boolean).join('\n');

        await runModelStep(step, {
            prompt,
            substatus: 'Writing revised sections…',
            systemPrompt: systemPromptWith(
                'You are a product planning analyst repairing document gaps. Follow instructions strictly.',
                settings
            ),
            maxOutputTokens: settings.documentMaxOutputTokens || 8192,
            temperature: settings.temperature,
            signal: options && options.signal
        }, hooks);

        core.writeFile(targetPath, step.text, { runId: run.id, revised: true });
        if (hooks && typeof hooks.onFileWritten === 'function') {
            try { hooks.onFileWritten(targetPath); } catch (_) {}
        }

        const review = reviewDocument(step.text, (gaps && gaps.requiredSections) || []);
        step.summary = review.ok ? 'All gaps repaired successfully' : `${review.missing.length} sections still missing`;
        core.saveRun(run);
        if (hooks && typeof hooks.onRender === 'function') {
            try { hooks.onRender(); } catch (err) { console.warn('[Blueprint] onRender hook error in gap repair:', err); }
        }
        return { path: targetPath, review };
    }

    window.__codalioBlueprintAgent = Object.freeze({
        MAX_PROMPT_PREVIEW,
        makeStep,
        askClarifyingQuestions,
        finishStep,
        runModelStep,
        runSkill,
        reviseDocumentGaps,
        collectExistingDocs,
        sourceFilesForModel,
        outputPathFor,
        applyDocumentHeader,
        reviewDocument,
        systemPromptWith,
        promptPreview,
        bounded,
        formatCompactionPrompt,
        stripCompactionFromPrompt,
        injectCompactionIntoPrompt,
        compressContext
    });
}());
