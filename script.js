'use strict';

let allBlocks = [];
let vocabularyList = []; // Each item: { id, word }
let blockCounter = 0;
let undoStack = []; // For undo/redo functionality

const editor = document.getElementById('textEditor');
const preview = document.getElementById('preview');

// --- Color Generation ---
const stringToSha1RgbColor = async (str) => {
    const normalizedStr = str.toLowerCase().trim();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalizedStr);
    const hashBuffer = await window.crypto.subtle.digest('SHA-1', data);
    const hashArray = new Uint8Array(hashBuffer);

    const r = hashArray[0];
    const g = hashArray[1];
    const b = hashArray[2];

    const toHex = (c) => c.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const mixHexColor = (hex, mixColorHex, weight) => {
    const color = parseInt(hex.slice(1), 16);
    const mixColor = parseInt(mixColorHex.slice(1), 16);
    const r = Math.round((color >> 16) * (1 - weight) + (mixColor >> 16) * weight);
    const g = Math.round(((color >> 8) & 0x00FF) * (1 - weight) + ((mixColor >> 8) & 0x00FF) * weight);
    const b = Math.round((color & 0x0000FF) * (1 - weight) + (mixColor & 0x0000FF) * weight);
    const toHex = (c) => c.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

// --- Modal Functions ---

// Generic modal for text editing (used by block edit)
const showEditModal = (title, initialContent, onSave) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-dialog">
            <h2>${title}</h2>
            <textarea id="modal-textarea">${initialContent}</textarea>
            <div class="modal-buttons">
                <button class="modal-cancel-btn">Отмена</button>
                <button class="modal-save-btn">Сохранить</button>
            </div>
        </div>
    `;
    const closeModal = () => { document.body.removeChild(overlay); document.removeEventListener('keydown', keydownHandler); };
    const keydownHandler = (e) => { if (e.key === 'Escape') closeModal(); };
    overlay.querySelector('.modal-save-btn').addEventListener('click', () => { onSave(overlay.querySelector('#modal-textarea').value); closeModal(); });
    overlay.querySelector('.modal-cancel-btn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    overlay.classList.add('show'); // Trigger fade-in
    overlay.querySelector('.modal-dialog').classList.add('show'); // Trigger scale-in
    document.addEventListener('keydown', keydownHandler);
    overlay.querySelector('#modal-textarea').focus();
};

// New modal for displaying HTML content (used by guide)
const showHtmlModal = (title, htmlContent) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-dialog">
            <h2>${title}</h2>
            <div class="modal-content-display">${htmlContent}</div>
            <div class="modal-buttons">
                <button class="modal-close-btn">Закрыть</button>
            </div>
        </div>
    `;
    const closeModal = () => { document.body.removeChild(overlay); document.removeEventListener('keydown', keydownHandler); };
    const keydownHandler = (e) => { if (e.key === 'Escape') closeModal(); };
    overlay.querySelector('.modal-close-btn').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
    overlay.classList.add('show'); // Trigger fade-in
    overlay.querySelector('.modal-dialog').classList.add('show'); // Trigger scale-in
    document.addEventListener('keydown', keydownHandler);
    // Focus the modal content to allow scrolling with keyboard, if needed
    overlay.querySelector('.modal-content-display').focus();
};


// --- Helper Functions ---
const getSelectedText = () => ({ text: editor.value.substring(editor.selectionStart, editor.selectionEnd) });
const applyFormatting = (tag) => {
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;
    const selectedText = editor.value.substring(selectionStart, selectionEnd);

    if (!selectedText) return;

    // Check if the selected text is already wrapped in the target tag
    const beforeSelection = editor.value.substring(0, selectionStart);
    const afterSelection = editor.value.substring(selectionEnd);
    const tagStart = `<${tag}>`;
    const tagEnd = `</${tag}>`;

    const isAlreadyFormatted = beforeSelection.endsWith(tagStart) && afterSelection.startsWith(tagEnd);

    if (isAlreadyFormatted) {
        // Remove formatting
        const newSelectionStart = selectionStart - tagStart.length;
        const newSelectionEnd = selectionEnd + tagEnd.length;
        editor.setRangeText(selectedText, newSelectionStart, newSelectionEnd, 'select');
    } else {
        // Apply formatting
        editor.setRangeText(tagStart + selectedText + tagEnd, selectionStart, selectionEnd, 'select');
    }
};

const highlightElement = (id) => {
    setTimeout(() => {
        const element = document.getElementById(id);
        if (element) {
            element.classList.add('highlight');
            element.onanimationend = () => element.classList.remove('highlight');
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 50);
};

// --- Dictionary URL Generators ---
const getCollinsUrl = (word) => `https://www.collinsdictionary.com/dictionary/english/${encodeURIComponent(word.trim().toLowerCase().replace(/\s+/g, '-'))}`;
const getCambridgeUrl = (word) => `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word.trim().toLowerCase().replace(/\s+/g, '-'))}`;
const getOxfordUrl = (word) => `https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(word.trim().toLowerCase().replace(/\s+/g, '-'))}`;
const getGoogleTranslateUrl = (word) => `https://translate.google.com/?sl=en&tl=ru&text=${encodeURIComponent(word.trim())}`;


// --- Internal Content Parsers ---

// This function parses a segment of content that is NOT split by the '/' responsive delimiter.
// It handles paragraphs, internal headers (*), and example groups (**)
const parseSimpleContent = async (simpleContent, isDialogueContext) => {
    let segments = [];
    let currentParagraphLines = [];
    let currentExampleLines = [];

    const flushParagraph = async (target = segments) => {
        if (currentParagraphLines.length > 0) {
            let htmlChunk = '';
            if (isDialogueContext && currentParagraphLines.some(line => line.includes(':'))) {
                let dialogueHtml = '';
                const dialogueLines = currentParagraphLines.filter(line => line.includes(':'));
                for (const [idx, dl] of dialogueLines.entries()) {
                    const parts = dl.split(/:\s*(.*)/s);
                    const speaker = parts[0].trim();
                    let replica = parts[1] ? parts[1].trim() : '';
                    const side = (idx % 2 === 0) ? 'left' : 'right';
                    replica = replica.replace(/\\/g, '<br>');
                    const baseColor = await stringToSha1RgbColor(speaker);
                    const bgColor = mixHexColor(baseColor, '#FFFFFF', 0.85);
                    const borderColor = mixHexColor(baseColor, '#FFFFFF', 0.65);
                    const speakerColor = mixHexColor(baseColor, '#000000', 0.6);
                    dialogueHtml += `<div class="dialogue-line ${side}" style="background-color: ${bgColor}; border-color: ${borderColor};">
                                          <strong class="dialogue-speaker" style="color: ${speakerColor};">${speaker}</strong>${replica}
                                      </div>`;
                }
                htmlChunk = dialogueHtml;
            } else {
                htmlChunk = `<div>${currentParagraphLines.join('<br>')}</div>`;
            }
            if (htmlChunk.trim() !== '') {
                target.push(htmlChunk);
            }
            currentParagraphLines = [];
        }
    };

    const flushExamples = (target = segments) => {
        if (currentExampleLines.length > 0) {
            const examplesHtml = currentExampleLines.map(line => `<div>${line.substring(2).trim().replace(/\n/g, '<br>')}</div>`).join('');
            if (examplesHtml.trim() !== '') {
                target.push(`<div class="internal-example-group">${examplesHtml}</div>`);
            }
            currentExampleLines = [];
        }
    };

    const simpleLinesArray = simpleContent.split('\n');
    for (const line of simpleLinesArray) {
        const trimmed = line.trim();

        if (trimmed.startsWith('**')) { // Internal Example Group
            await flushParagraph(); // Flush any pending paragraph before starting examples
            currentExampleLines.push(line);
        } else if (trimmed.startsWith('*')) { // Internal Header (H3)
            await flushParagraph(); // Flush any pending paragraph
            flushExamples(); // Flush any pending examples
            segments.push(`<div class="internal-block-header">${trimmed.substring(1).trim()}</div>`);
        } else if (trimmed.length === 0) { // Empty line: signifies paragraph break
            await flushParagraph();
            flushExamples();
        } else { // Regular text line
            flushExamples(); // If text follows examples, finalize examples and start new paragraph
            currentParagraphLines.push(line);
        }
    }
    await flushParagraph(); // Final flush of any remaining paragraph
    flushExamples(); // Final flush of any remaining examples

    return segments.join('');
};

// This is the main internal parser for a block's content.
// It handles the top-level internal structure: _ separators, / responsive columns, and initial * header.
const parseInternalBlockContent = async (content, isDialogueContext = false) => {
    let finalHtmlSegments = [];
    let remainingContent = content;

    // 1. Handle initial '*' header if it exists at the very beginning of the block content
    const lines = content.split('\n');
    if (lines.length > 0 && lines[0].trim().startsWith('*')) {
        const headerText = lines[0].trim().substring(1).trim();
        if (headerText) { // Ensure header isn't empty after trimming '*'
            finalHtmlSegments.push(`<div class="internal-block-header">${headerText}</div>`);
        }
        remainingContent = lines.slice(1).join('\n'); // Update content to exclude the header line
    }

    // 2. Process the rest of the content, splitting by internal horizontal separator: _
    const horizontalDelimiterRegex = /(\n_\n)/g;
    const majorSegments = remainingContent.split(horizontalDelimiterRegex);

    let currentSegmentText = ''; // Accumulates content that will become one group (responsive or simple)
    for (const part of majorSegments) {
        if (part === undefined || part.length === 0) continue;

        const trimmedPart = part.trim();

        if (trimmedPart === '_') { // This part is a horizontal delimiter
            // Process the content that accumulated BEFORE this delimiter
            if (currentSegmentText.trim().length > 0) {
                // Check if this segment contains a responsive column delimiter '/'
                if (currentSegmentText.includes('\n/\n')) {
                    const responsiveColumnsText = currentSegmentText.split('\n/\n').map(itemText => itemText.trim());
                    let itemsHtml = '';
                    for (let j = 0; j < responsiveColumnsText.length; j++) {
                        const itemHtmlContent = await parseSimpleContent(responsiveColumnsText[j], isDialogueContext);
                        if (itemHtmlContent.trim() !== '') {
                            itemsHtml += `<div class="responsive-content-item">${itemHtmlContent}</div>`;
                            if (j < responsiveColumnsText.length - 1 && responsiveColumnsText[j+1].trim() !== '') {
                                itemsHtml += `<span class="responsive-pipe">|</span>`;
                            }
                        }
                    }
                    if (itemsHtml.trim() !== '') {
                        finalHtmlSegments.push(`<div class="responsive-content-group">${itemsHtml}</div>`);
                    }
                } else {
                    // If no responsive items, parse as simple content
                    finalHtmlSegments.push(await parseSimpleContent(currentSegmentText, isDialogueContext));
                }
            }
            currentSegmentText = ''; // Reset for the next content segment

            // Add the horizontal delimiter itself as an HTML segment
            finalHtmlSegments.push(`<div class="internal-block-separator"></div>`);

        } else {
            // This part is content, accumulate it
            currentSegmentText += part;
        }
    }

    // Process any remaining content after the last delimiter or if no delimiters were present
    if (currentSegmentText.trim().length > 0) {
        if (currentSegmentText.includes('\n/\n')) {
            const responsiveColumnsText = currentSegmentText.split('\n/\n').map(itemText => itemText.trim());
            let itemsHtml = '';
            for (let j = 0; j < responsiveColumnsText.length; j++) {
                const itemHtmlContent = await parseSimpleContent(responsiveColumnsText[j], isDialogueContext);
                if (itemHtmlContent.trim() !== '') {
                    itemsHtml += `<div class="responsive-content-item">${itemHtmlContent}</div>`;
                    if (j < responsiveColumnsText.length - 1 && responsiveColumnsText[j+1].trim() !== '') {
                        itemsHtml += `<span class="responsive-pipe">|</span>`;
                    }
                }
            }
            if (itemsHtml.trim() !== '') {
                finalHtmlSegments.push(`<div class="responsive-content-group">${itemsHtml}</div>`);
            }
        } else {
            finalHtmlSegments.push(await parseSimpleContent(currentSegmentText, isDialogueContext));
        }
    }

    return finalHtmlSegments.join('');
};


// --- Block HTML Generation using the unified parser ---
const createRuleHtml = async (content) => `<div class="rule-block">${await parseInternalBlockContent(content)}</div>`;
const createExampleHtml = async (content) => `<div class="example-block">${await parseInternalBlockContent(content)}</div>`;
const createCenteredHtml = async (content) => `<div class="centered-block">${await parseInternalBlockContent(content)}</div>`;
const createSeparatorHtml = () => `<div class="separator-wrapper"><hr class="compact-separator"></div>`;
const createDialogueHtml = async (content) => `<div class="dialogue-block">${await parseInternalBlockContent(content, true)}</div>`;
const createMarkupHeaderHtml = (content) => `<div class="markup-header-block">${content}</div>`;

const getHtmlForBlock = async (block) => {
    switch(block.type) {
        case 'rule': return await createRuleHtml(block.content);
        case 'dialogue': return await createDialogueHtml(block.content);
        case 'example': return await createExampleHtml(block.content);
        case 'centered': return await createCenteredHtml(block.content);
        case 'separator': return createSeparatorHtml();
        case 'markup-header': return createMarkupHeaderHtml(block.content);
        default: return '';
    }
};

// --- Block Management ---
const saveStateForUndo = () => {
    const state = {
        allBlocks: JSON.parse(JSON.stringify(allBlocks)),
        vocabularyList: JSON.parse(JSON.stringify(vocabularyList)),
        blockCounter,
        editorText: editor.value
    };
    undoStack.push(state);
    if (undoStack.length > 20) undoStack.shift(); // Limit undo stack size
};

const createBlock = async (type, content = '', insertAfterIndex = -1) => {
    saveStateForUndo();
    const id = `${type}-${++blockCounter}`;
    let newOrder = Date.now();
    allBlocks.sort((a, b) => a.order - b.order);

    if (insertAfterIndex !== -1) {
        if (insertAfterIndex === 0) {
             newOrder = allBlocks.length > 0 ? allBlocks[0].order - 1 : Date.now();
        } else if (insertAfterIndex > 0 && insertAfterIndex <= allBlocks.length) {
            const prevBlock = allBlocks[insertAfterIndex - 1];
            const nextBlock = allBlocks[insertAfterIndex];
            newOrder = nextBlock ? (prevBlock.order + nextBlock.order) / 2 : prevBlock.order + 1;
        }
    } else {
        newOrder = allBlocks.length > 0 ? allBlocks[allBlocks.length - 1].order + 1 : Date.now();
    }

    allBlocks.push({ id, type, content, order: newOrder });
    await renderPreview();
    highlightElement(id);
    autoSaveToLocalStorage();
};

const handleBlockCreation = async (event, type, requiresSelection = true) => {
    const selection = getSelectedText();
    let rawContent = selection.text;

    if (requiresSelection && rawContent.trim().length === 0) {
        if (!confirm(`Вы не выделили текст. Хотите создать пустой блок типа "${type}"?`)) {
            return;
        }
        rawContent = '';
    }

    let insertIndex = -1;
    if (event.ctrlKey) {
        const existingBlockCount = allBlocks.length;
        const posStr = prompt(`Вставить после блока номер (0 для самого верха, максимум ${existingBlockCount}):`, `${existingBlockCount}`);
        if (posStr === null) return;
        const index = parseInt(posStr, 10);
        if (isNaN(index) || index < 0 || index > existingBlockCount) return alert('Неверный номер блока.');
        insertIndex = index;
    }
    await createBlock(type, rawContent, insertIndex);
};

// --- Handler for Header Block Button (for external H1-like blocks) ---
const handleHeaderBlockCreation = async (event) => {
    const selection = getSelectedText();
    let content = selection.text.trim();

    if (!content) {
        if (!confirm("Текст не выделен. Хотите создать пустой блок заголовка?")) {
            return;
        }
        content = '';
    }
    if (content.startsWith('*')) {
        content = content.substring(1).trim();
    }

    let insertIndex = -1;
    if (event.ctrlKey) {
        const existingBlockCount = allBlocks.length;
        const posStr = prompt(`Вставить после блока номер (0 для самого верха, максимум ${existingBlockCount}):`, `${existingBlockCount}`);
        if (posStr === null) return;
        const index = parseInt(posStr, 10);
        if (isNaN(index) || index < 0 || index > existingBlockCount) return alert('Неверный номер блока.');
        insertIndex = index;
    }
    await createBlock('markup-header', content, insertIndex);
};


// --- Simplified Vocabulary Management ---

const addVocabularyWord = async () => {
    saveStateForUndo();
    const selection = getSelectedText();
    const wordsToAdd = selection.text.split('\n').map(word => word.trim()).filter(word => word.length > 0);

    if (wordsToAdd.length === 0) {
        if (!confirm("Текст не выделен. Хотите добавить пустую словарную запись?")) {
            return;
        }
        wordsToAdd.push("");
    }

    let lastAddedId = null;
    wordsToAdd.forEach(word => {
        // Check if word already exists (case-insensitive) to avoid duplicates
        if (!vocabularyList.some(item => item.word.toLowerCase() === word.toLowerCase())) {
            const id = 'vocab-' + (++blockCounter);
            vocabularyList.push({ id, word: word });
            lastAddedId = id;
        }
    });
    await renderPreview();
    if (lastAddedId) {
        highlightElement(lastAddedId);
    }
    autoSaveToLocalStorage();
};

// --- File Save/Load Functions ---

const saveDataToFile = () => {
    const dataToSave = {
        allBlocks: allBlocks,
        vocabularyList: vocabularyList,
        blockCounter: blockCounter,
        editorText: editor.value
    };
    const jsonString = JSON.stringify(dataToSave, null, 2);

    const blob = new Blob([jsonString], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'english_editor_data.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    alert('Данные сохранены в english_editor_data.json');
};

const loadDataFromFile = () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.style.display = 'none';

    fileInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) {
            alert('Файл не выбран.');
            return;
        }

        if (allBlocks.length > 0 || vocabularyList.length > 0 || editor.value.trim().length > 0) {
            if (!confirm('Загрузка этого файла перезапишет вашу текущую работу. Продолжить?')) {
                event.target.value = '';
                return;
            }
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const loadedData = JSON.parse(e.target.result);
                if (loadedData.allBlocks && loadedData.vocabularyList && loadedData.blockCounter !== undefined && loadedData.editorText !== undefined) {
                    saveStateForUndo(); // Save current state before loading
                    allBlocks = loadedData.allBlocks;
                    vocabularyList = loadedData.vocabularyList;
                    blockCounter = loadedData.blockCounter;
                    editor.value = loadedData.editorText;
                    await renderPreview();
                    alert('Данные успешно загружены из файла!');
                    autoSaveToLocalStorage();
                } else {
                    alert('Неверный формат файла. Пожалуйста, выберите действительный JSON-файл с данными редактора.');
                }
            } catch (error) {
                console.error('Ошибка при разборе JSON-файла:', error);
                alert('Ошибка при разборе JSON-файла. Убедитесь, что это действительный JSON.');
            }
        };
        reader.onerror = (error) => {
            console.error('Ошибка при чтении файла:', error);
            alert('Ошибка при чтении файла.');
        };
        reader.readAsText(file);
    });

    document.body.appendChild(fileInput);
    fileInput.click();
    document.body.removeChild(fileInput); // Clean up
};


// --- Save As HTML (for file export) ---
const saveAsHTML = async () => {
    const title = prompt("Введите заголовок для HTML-файла:", "Мои заметки по английскому");
    if (!title) return;
    // We need to fetch the styles from the external stylesheet
    const styleLink = document.querySelector('link[rel="stylesheet"]');
    let styles = '';
    if (styleLink) {
        try {
            const response = await fetch(styleLink.href);
            styles = await response.text();
        } catch (error) {
            console.error('Error fetching stylesheet:', error);
            alert('Не удалось загрузить стили для экспорта HTML. Экспорт без стилей.');
        }
    }


    let finalHtmlContent = '';
    for (const block of allBlocks.sort((a,b) => a.order - b.order)) {
        finalHtmlContent += await getHtmlForBlock(block);
    }
    if (vocabularyList.length > 0) {
         finalHtmlContent += '<div class="vocabulary-master-block"><h2>📖 Словарь</h2>' + vocabularyList.map(item => {
            const word = item.word;
            return `<div class="vocab-item">
                        <div class="vocab-item-word">
                            <span class="main-word">${word}</span>
                            <div class="dict-buttons">
                                <a href="${getCollinsUrl(word)}" target="_blank" class="dict-btn collins">Collins</a>
                                <a href="${getCambridgeUrl(word)}" target="_blank" class="dict-btn cambridge">Cambridge</a>
                                <a href="${getOxfordUrl(word)}" target="_blank" class="dict-btn oxford">Oxford</a>
                                <a href="${getGoogleTranslateUrl(word)}" target="_blank" class="dict-btn google">Google</a>
                            </div>
                        </div>
                    </div>`;
        }).join('') + '</div>';
    }

    const titleBlock = `<div class="html-title-block"><h1>${title}</h1></div>`;
    // ДОБАВЛЕНО: <meta name="viewport" content="width=device-width, initial-scale=1.0">
    const fullHtml = `
        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
        <style>${styles}</style></head>
        <body><div class="container">${titleBlock}${finalHtmlContent}</div></body></html>`;
    const blob = new Blob([fullHtml], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/\s/g, '_')}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
};

// --- Open Preview in New Tab Function ---
const openPreviewInNewTab = async () => {
    // We need to fetch the styles from the external stylesheet
    const styleLink = document.querySelector('link[rel="stylesheet"]');
    let styles = '';
    if (styleLink) {
        try {
            const response = await fetch(styleLink.href);
            styles = await response.text();
        } catch (error) {
            console.error('Error fetching stylesheet for new tab preview:', error);
            alert('Не удалось загрузить стили для предварительного просмотра в новой вкладке. Предварительный просмотр может быть без стилей.');
        }
    }

    let previewContentHtml = '';
    const previewTitle = prompt("Введите заголовок для Live Preview:", "Live Preview - Мои заметки по английскому");
    const titleBlock = previewTitle ? `<div class="html-title-block"><h1>${previewTitle}</h1></div>` : '';


    for (const block of allBlocks.sort((a,b) => a.order - b.order)) {
        previewContentHtml += await getHtmlForBlock(block);
    }
    if (vocabularyList.length > 0) {
         previewContentHtml += '<div class="vocabulary-master-block"><h2>📖 Словарь</h2>' + vocabularyList.map(item => {
            const word = item.word;
            return `<div class="vocab-item">
                                <div class="vocab-item-word">
                                    <span class="main-word">${word}</span>
                                    <div class="dict-buttons">
                                        <button class="dict-btn collins" data-url="${getCollinsUrl(word)}" title="Открыть в Collins">Collins</button>
                                        <button class="dict-btn cambridge" data-url="${getCambidgeUrl(word)}" title="Открыть в Cambridge">Cambridge</button>
                                        <button class="dict-btn oxford" data-url="${getOxfordUrl(word)}" title="Открыть в Oxford">Oxford</button>
                                        <button class="dict-btn google" data-url="${getGoogleTranslateUrl(word)}" title="Открыть в Google Translate">Google</button>
                                    </div>
                                </div>
                            </div>`;
        }).join('') + '</div>';
    }
    if (!allBlocks.length && !vocabularyList.length) {
        previewContentHtml += '<p style="color: #7f8c8d; margin-top: 10px;">Нет содержимого для предварительного просмотра.</p>';
    }

    // ДОБАВЛЕНО: <meta name="viewport" content="width=device-width, initial-scale=1.0">
    const fullHtml = `
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${previewTitle || "Live Preview"}</title>
            <style>${styles}</style>
        </head>
        <body>
            <div class="container">
                ${titleBlock}
                ${previewContentHtml}
            </div>
        </body>
        </html>`;

    const newTab = window.open('', '_blank');
    if (newTab) {
        newTab.document.write(fullHtml);
        newTab.document.close();
    } else {
        alert('Не удалось открыть новую вкладку. Пожалуйста, проверьте настройки вашего браузера или убедитесь, что всплывающие окна разрешены для этой страницы.');
    }
};


// --- Render Function (for the in-page preview) ---
const renderPreview = async () => {
    allBlocks.sort((a, b) => a.order - b.order);
    let finalHtml = '<h3>📋 Отформатированные блоки</h3>';

    for (const [index, block] of allBlocks.entries()) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = await getHtmlForBlock(block);
        const blockElement = tempDiv.firstElementChild;
        if (blockElement) {
            blockElement.id = block.id;
            blockElement.dataset.type = block.type;
            blockElement.draggable = true; // Enable drag and drop
            let controls = `<button class="delete-btn" title="Удалить">×</button>`;
            if (block.type !== 'separator' && block.type !== 'vocab') {
                 controls = `<span class="block-number" title="Нажмите, чтобы переместить">#${index + 1}</span><button class="edit-btn" title="Редактировать">✏️</button>` + controls;
            } else if (block.type === 'markup-header' || block.type === 'separator') {
                controls = `<span class="block-number" title="Нажмите, чтобы переместить">#${index + 1}</span>` + controls;
            }

            const controlsWrapper = document.createElement('div');
            controlsWrapper.className = 'block-controls';
            controlsWrapper.innerHTML = controls;
            if (block.type === 'separator') {
                controlsWrapper.style.top = '50%';
                controlsWrapper.style.transform = 'translateY(-50%)';
            }
            blockElement.appendChild(controlsWrapper);
            finalHtml += blockElement.outerHTML;
        }
    }

    if (vocabularyList.length > 0) {
         finalHtml += '<div class="vocabulary-master-block"><h2>📖 Словарь</h2>' + vocabularyList.map(item => {
            const word = item.word;
            return `<div class="vocab-item" id="${item.id}" data-type="vocab">
                                <div class="block-controls">
                                  <button class="delete-btn" title="Удалить">×</button>
                                </div>
                                <div class="vocab-item-word">
                                    <span class="main-word">${word}</span>
                                    <div class="dict-buttons">
                                        <button class="dict-btn collins" data-url="${getCollinsUrl(word)}" title="Открыть в Collins">Collins</button>
                                        <button class="dict-btn cambridge" data-url="${getCambridgeUrl(word)}" title="Открыть в Cambridge">Cambridge</button>
                                        <button class="dict-btn oxford" data-url="${getOxfordUrl(word)}" title="Открыть в Oxford">Oxford</button>
                                        <button class="dict-btn google" data-url="${getGoogleTranslateUrl(word)}" title="Открыть в Google Translate">Google</button>
                                    </div>
                                </div>
                            </div>`;
        }).join('') + '</div>';
    }
    if (!allBlocks.length && !vocabularyList.length) {
        finalHtml += '<p style="color: #7f8c8d; margin-top: 10px;">Выделите текст и выберите тип блока, чтобы начать.</p>';
    }
    preview.innerHTML = finalHtml;
};

// --- Auto-save to Local Storage ---
const autoSaveToLocalStorage = () => {
    const dataToSave = {
        allBlocks,
        vocabularyList,
        blockCounter,
        editorText: editor.value
    };
    localStorage.setItem('englishEditorAutoSave', JSON.stringify(dataToSave));
};

const loadFromLocalStorage = () => {
    const savedData = localStorage.getItem('englishEditorAutoSave');
    if (savedData) {
        const loadedData = JSON.parse(savedData);
        allBlocks = loadedData.allBlocks || [];
        vocabularyList = loadedData.vocabularyList || [];
        blockCounter = loadedData.blockCounter || 0;
        editor.value = loadedData.editorText || '';
        renderPreview();
    }
};

// --- Undo Functionality ---
const undoLastAction = () => {
    if (undoStack.length > 0) {
        const previousState = undoStack.pop();
        allBlocks = previousState.allBlocks;
        vocabularyList = previousState.vocabularyList;
        blockCounter = previousState.blockCounter;
        editor.value = previousState.editorText;
        renderPreview();
        autoSaveToLocalStorage();
    } else {
        alert('Больше нет действий для отмены.');
    }
};

// --- Drag and Drop for Reordering Blocks ---
let dragSrcEl = null;

const handleDragStart = (e) => {
    dragSrcEl = e.target.closest('[data-type]');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrcEl.id);
};

const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
};

const handleDrop = (e) => {
    e.preventDefault();
    const dropTarget = e.target.closest('[data-type]');
    if (dropTarget && dragSrcEl !== dropTarget) {
        saveStateForUndo();
        const srcId = dragSrcEl.id;
        const targetId = dropTarget.id;
        const srcIndex = allBlocks.findIndex(b => b.id === srcId);
        const targetIndex = allBlocks.findIndex(b => b.id === targetId);

        if (srcIndex !== -1 && targetIndex !== -1) {
            const [movedBlock] = allBlocks.splice(srcIndex, 1);
            allBlocks.splice(targetIndex, 0, movedBlock);

            // Recalculate orders
            allBlocks.forEach((block, idx) => {
                block.order = idx;
            });

            renderPreview();
            autoSaveToLocalStorage();
        }
    }
};

// --- Guide Content (Russian) ---
const GUIDE_HTML_CONTENT_RU = `
    <h3>🚀 Добро пожаловать в Редактор текстов по английским правилам!</h3>
    <p>Это подробное руководство поможет вам эффективно использовать все функции для создания и оформления заметок по английскому языку.</p>

    <h4>📝 1. Основное форматирование текста</h4>
    <p>Эти кнопки позволяют форматировать выделенный текст непосредственно в <b>Редакторе</b> (левая панель). Нажмите повторно, чтобы снять форматирование.</p>
    <ul>
        <li>
            <button class="format-btn"><b>B</b></button> (Жирный): Делает выделенный текст <b>жирным</b>.
            (Горячая клавиша: <code>Ctrl + B</code>)
            <br>
            <em>В редакторе:</em> <code>Текст может быть &lt;b&gt;жирным&lt;/b&gt;.</code>
            <br>
            <em>В предпросмотре:</em> <span>Текст может быть <b>жирным</b>.</span>
        </li>
        <li>
            <button class="format-btn"><i>I</i></button> (Курсив): Делает выделенный текст <i>курсивом</i>.
            (Горячая клавиша: <code>Ctrl + I</code>)
            <br>
            <em>В редакторе:</em> <code>Текст может быть &lt;i&gt;курсивом&lt;/i&gt;.</code>
            <br>
            <em>В предпросмотре:</em> <span>Текст может быть <i>курсивом</i>.</span>
        </li>
        <li>
            <button class="format-btn"><s>S</s></button> (Зачеркнутый): Добавляет <s>зачеркивание</s> к выделенному тексту.
            (Горячая клавиша: <code>Ctrl + Shift + S</code>)
            <br>
            <em>В редакторе:</em> <code>Текст может быть &lt;s&gt;зачеркнутым&lt;/s&gt;.</code>
            <br>
            <em>В предпросмотре:</em> <span>Текст может быть <s>зачеркнутым</s>.</span>
        </li>
    </ul>

    <h4>🧱 2. Создание основных блоков</h4>
    <p>Эти кнопки создают отдельные, визуально выделенные блоки в <b>Предварительном просмотре</b> (правая панель). Выделите текст в редакторе и нажмите кнопку, чтобы добавить его как содержимое нового блока. Если текст не выделен, вам будет предложено создать пустой блок.</p>
    <p><b>Ctrl + Клик (или Cmd + Клик на Mac):</b> При нажатии на любую кнопку создания блока с зажатой клавишей <code>Ctrl</code> (или <code>Cmd</code>) вам будет предложено ввести позицию для вставки блока (<code>0</code> для самого верха или номер блока, после которого нужно вставить).</p>
    <ul>
        <li>
            <button class="tool-btn rule-btn">📚</button> <b>Блок правил:</b> Идеален для грамматических правил, объяснений или основных положений.
            <br>
            <em>В редакторе (пример содержимого):</em>
            <pre><code>Это важное правило.
Здесь будет его объяснение.</code></pre>
            <em>В предпросмотре:</em>
            <div class="rule-block" style="margin: 5px 0; padding: 10px; font-size: 0.9em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 5px solid #c0392b;">
                <div>Это важное правило.</div>
                <div>Здесь будет его объяснение.</div>
            </div>
        </li>
        <li>
            <button class="tool-btn dialogue-btn">💬</button> <b>Блок диалога:</b> Специально разработан для форматирования бесед.
            <br>
            <em>В редакторе (пример содержимого):</em>
            <pre><code>John: Hello, how are you?
Mary: I'm fine, thanks!</code></pre>
            <em>В предпросмотре:</em>
            <div class="dialogue-block" style="margin: 5px 0; padding: 10px; font-size: 0.9em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 5px solid var(--secondary-color);">
                <div class="dialogue-line left" style="background-color: #e8f4ff; border-color: #d9eaff; padding: 8px 12px; border-radius: 20px; margin-right: auto;">
                    <strong class="dialogue-speaker" style="color: var(--primary-color);">John</strong>Hello, how are you?
                </div>
                <div class="dialogue-line right" style="background-color: #e8f4ff; border-color: #d9eaff; padding: 8px 12px; border-radius: 20px; margin-left: auto;">
                    <strong class="dialogue-speaker" style="color: var(--primary-color);">Mary</strong>I'm fine, thanks!
                </div>
            </div>
        </li>
        <li>
            <button class="tool-btn example-btn">💡</button> <b>Блок примеров:</b> Отлично подходит для демонстрации примеров, связанных с правилами или понятиями.
            <br>
            <em>В редакторе (пример содержимого):</em>
            <pre><code>**This is an example.
**Another one.</code></pre>
            <em>В предпросмотре:</em>
            <div class="example-block" style="margin: 5px 0; padding: 10px; font-size: 0.9em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 5px solid var(--info-color);">
                <div class="internal-example-group" style="margin-top: 5px; padding: 8px 10px; background: #f2f2f2; border-left: 3px solid var(--warning-color); border-radius: 5px;">
                    <div>This is an example.</div>
                    <div>Another one.</div>
                </div>
            </div>
        </li>
        <li>
            <button class="tool-btn center-btn">T</button> <b>Блок выровненного по центру текста:</b> Выравнивает текстовое содержимое внутри блока по центру.
            <br>
            <em>В редакторе (пример содержимого):</em>
            <pre><code>Текст, который будет по центру.</code></pre>
            <em>В предпросмотре:</em>
            <div class="centered-block" style="margin: 5px 0; padding: 10px; text-align: center; font-size: 0.9em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 5px solid #d35400;">
                <div>Текст, который будет по центру.</div>
            </div>
        </li>
        <li>
            <button class="tool-btn line-btn">➖</button> <b>Линия-разделитель:</b> Вставляет простую горизонтальную линию для визуального разделения больших секций. (Не требует выделения текста).
            <br>
            <em>В предпросмотре:</em>
            <div class="separator-wrapper" style="margin: 5px 0; padding: 5px 0; cursor: pointer;">
                <hr class="compact-separator" style="width: 80%; margin: 0 auto; height: 3px; background: var(--neutral-medium); border: none; opacity: 0.6;">
            </div>
        </li>
        <li>
            <button class="tool-btn header-block-btn">⭐</button> <b>Блок основного заголовка (HTML H1):</b> Создает заметный, крупный заголовок уровня страницы. Используйте его умеренно для названий глав или разделов.
            <br>
            <em>В редакторе (пример содержимого):</em>
            <pre><code>Название новой главы</code></pre>
            <em>В предпросмотре:</em>
            <div class="markup-header-block" style="margin: 5px 0; padding: 15px 20px; font-size: 1.5em; font-weight: bold; color: var(--neutral-dark); background: linear-gradient(to bottom, #e0f2f7, #d1e9f0); border-left: 5px solid var(--primary-color); border-radius: 10px;">
                Название новой главы
            </div>
        </li>
    </ul>

    <h4>⚙️ 3. Внутреннее форматирование контента в блоках</h4>
    <p>Эти специальные символы позволяют форматировать контент <b>внутри любого созданного блока</b> (Правило, Диалог, Пример, Центрированный Текст). Просто введите их в редакторе на отдельной строке или в начале строки:</p>
    <div style="border: 1px solid #ccc; border-radius: 8px; padding: 15px; margin-bottom: 20px; background-color: #f9f9f9;">
        <p><em>Пример форматирования внутри условного блока (например, "Блока правил"):</em></p>
        <hr style="border: none; border-top: 1px dashed #eee; margin: 15px 0;">

        <h5>3.1. <code>* Ваш Внутренний Заголовок</code></h5>
        <p>Строка, начинающаяся с одной звездочки, создает меньший, жирный <b>внутренний заголовок (H3)</b> внутри блока.</p>
        <em>В редакторе:</em>
        <pre><code>Это обычный текст.
* Заголовок раздела
А это текст под заголовком.</code></pre>
        <em>В предпросмотре (внутри блока):</em>
        <div style="border: 1px dashed #d0d0d0; padding: 10px; margin: 5px 0; background-color: #fcfcfc; border-radius: 5px;">
            <div>Это обычный текст.</div>
            <div class="internal-block-header" style="font-weight: bold; font-size: 1.1em; margin: 10px 0 5px 0; border-bottom: 1px dashed #ccc;">Заголовок раздела</div>
            <div>А это текст под заголовком.</div>
        </div>

        <h5>3.2. <code>** Ваша строка-пример</code></h5>
        <p>Строка, начинающаяся с двух звездочек, создает <em>курсивную строку-пример</em>. Последовательные строки-примеры будут сгруппированы в отдельный блок-контейнер.</p>
        <em>В редакторе:</em>
        <pre><code>Вот объяснение.
** This is an example sentence.
** Another example here.
Далее текст.</code></pre>
        <em>В предпросмотре (внутри блока):</em>
        <div style="border: 1px dashed #d0d0d0; padding: 10px; margin: 5px 0; background-color: #fcfcfc; border-radius: 5px;">
            <div>Вот объяснение.</div>
            <div class="internal-example-group" style="margin-top: 10px; padding: 12px 15px; background: #f2f2f2; border-left: 3px solid var(--warning-color); border-radius: 5px;">
                <div><em>This is an example sentence.</em></div>
                <div><em>Another example here.</em></div>
            </div>
            <div>Далее текст.</div>
        </div>

        <h5>3.3. <code>_</code> (одиночное подчеркивание на отдельной строке)</h5>
        <p>Вставляет компактный <b>горизонтальный разделитель</b> внутри блока.</p>
        <em>В редакторе:</em>
        <pre><code>Верхняя часть контента.
_
Нижняя часть контента.</code></pre>
        <em>В предпросмотре (внутри блока):</em>
        <div style="border: 1px dashed #d0d0d0; padding: 10px; margin: 5px 0; background-color: #fcfcfc; border-radius: 5px;">
            <div>Верхняя часть контента.</div>
            <div class="internal-block-separator" style="height: 2px; background: var(--neutral-medium); margin: 20px 0; border-radius: 1px; opacity: 0.7;"></div>
            <div>Нижняя часть контента.</div>
        </div>

        <h5>3.4. <code>/</code> (одиночный слеш на отдельной строке)</h5>
        <p>Создает <b>адаптивные колонки</b>. Содержимое между разделителями <code>/</code> будет отображаться рядом в предварительном просмотре (и переноситься на меньших экранах). <b>Важно:</b> Внутри колонок также можно использовать <code>*</code> и <code>**</code>!</p>
        <em>В редакторе:</em>
        <pre><code>Первая колонка с текстом
**Пример в первой колонке
/
Вторая колонка с другим текстом
*Подзаголовок во второй колонке</code></pre>
        <em>В предпросмотре (внутри блока):</em>
        <div style="border: 1px dashed #d0d0d0; padding: 10px; margin: 5px 0; background-color: #fcfcfc; border-radius: 5px;">
            <div class="responsive-content-group" style="display: flex; flex-wrap: wrap; gap: 10px; margin: 15px 0; padding: 10px 0; border-top: 1px solid var(--neutral-medium); border-bottom: 1px solid var(--neutral-medium);">
                <div class="responsive-content-item" style="flex: 1 1 150px; padding: 10px 15px; border: 1px solid #dcdcdc; border-radius: 8px; background-color: #fcfcfc;">
                    <div>Первая колонка с текстом</div>
                    <div class="internal-example-group" style="margin-top: 5px; padding: 8px 10px; background: #f2f2f2; border-left: 3px solid var(--warning-color); border-radius: 5px;">
                        <div><em>Пример в первой колонке</em></div>
                    </div>
                </div>
                <span class="responsive-pipe" style="display: flex; align-items: center; padding: 0 8px; font-weight: bold; color: var(--neutral-medium);">|</span>
                <div class="responsive-content-item" style="flex: 1 1 150px; padding: 10px 15px; border: 1px solid #dcdcdc; border-radius: 8px; background-color: #fcfcfc;">
                    <div>Вторая колонка с другим текстом</div>
                    <div class="internal-block-header" style="font-weight: bold; font-size: 1.1em; margin: 10px 0 5px 0; border-bottom: 1px dashed #ccc;">Подзаголовок во второй колонке</div>
                </div>
            </div>
        </div>
        
        <h5>3.5. <b>Особый случай: Форматирование диалога</b></h5>
        <p>Это форматирование актуально <b>только внутри <button class="tool-btn dialogue-btn">💬</button> Блока диалога</b>. Используйте формат <code>Имя_говорящего: Текст реплики</code> для автоматического оформления и цвета говорящего. Используйте <code>\\</code> для переноса строки внутри одной реплики.</p>
        <p><em>Если обычный текст или другие внутренние форматирования (<code>*</code>, <code>**</code>, <code>_</code>, <code>/</code>) используются внутри Диалогового блока, они будут отображаться как обычные абзацы или соответствующие им элементы, не в виде реплик.</em></p>
        <em>В редакторе:</em>
        <pre><code>Алиса: Привет, как дела?\\Что нового?
Боб: Отлично, спасибо!
* Внутренний заголовок внутри диалога
_
Обычный текст.</code></pre>
        <em>В предпросмотре (внутри блока диалога):</em>
        <div class="dialogue-block" style="margin: 5px 0; padding: 10px; font-size: 0.9em; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 5px solid var(--secondary-color);">
            <div class="dialogue-line left" style="background-color: #e8f4ff; border-color: #d9eaff; padding: 8px 12px; border-radius: 20px; margin-right: auto;">
                <strong class="dialogue-speaker" style="color: var(--primary-color);">Алиса</strong>Привет, как дела?<br>Что нового?
            </div>
            <div class="dialogue-line right" style="background-color: #e8f4ff; border-color: #d9eaff; padding: 8px 12px; border-radius: 20px; margin-left: auto;">
                <strong class="dialogue-speaker" style="color: var(--primary-color);">Боб</strong>Отлично, спасибо!
            </div>
            <div class="internal-block-header" style="font-weight: bold; font-size: 1.1em; margin: 10px 0 5px 0; border-bottom: 1px dashed #ccc;">Внутренний заголовок внутри диалога</div>
            <div class="internal-block-separator" style="height: 2px; background: var(--neutral-medium); margin: 20px 0; border-radius: 1px; opacity: 0.7;"></div>
            <div>Обычный текст.</div>
        </div>
    </div>


    <h4>📖 4. Управление словарным запасом</h4>
    <ul>
        <li>
            <button class="tool-btn vocab-btn">📖</button> <b>Добавить словарное слово:</b> Выделите слово или фразу в Редакторе и нажмите эту кнопку, чтобы добавить его в ваш Словарный список, который отображается в самом низу предпросмотра. Дубликаты (без учета регистра) не добавляются.
            <br>
            <em>Пример в предпросмотре:</em>
            <div class="vocabulary-master-block" style="margin: 5px 0; padding: 10px; background: linear-gradient(to bottom, var(--neutral-dark), #2c3e50); border-radius: 8px; color: white; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">
                <h2 style="font-size: 1.2em; text-align: center; margin: -10px -10px 10px -10px; background: linear-gradient(135deg, #2c3e50, #23313f); padding: 8px; border-radius: 5px 5px 0 0;">📖 Словарь</h2>
                <div class="vocab-item" style="background: rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 10px; margin-bottom: 5px; border: 1px solid rgba(255,255,255,0.15);">
                    <div class="vocab-item-word" style="font-size: 1em; display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap;">
                        <span class="main-word" style="color: #a29bfe; font-weight: bold;">Example Word</span>
                        <div class="dict-buttons" style="display: flex; gap: 3px; flex-wrap: wrap; margin-left: auto;">
                            <button class="dict-btn collins" style="padding: 4px 8px; font-size: 0.7em; border-radius: 20px; background: linear-gradient(135deg, #1abc9c, #16a085);">Collins</button>
                            <button class="dict-btn cambridge" style="padding: 4px 8px; font-size: 0.7em; border-radius: 20px; background: var(--primary-gradient);">Cambridge</button>
                        </div>
                    </div>
                </div>
            </div>
        </li>
        <li>
            <b>Кнопки словарей:</b> Каждый элемент словаря в предпросмотре включает кнопки для быстрого поиска слова в различных онлайн-словарях (Collins, Cambridge, Oxford, Google Translate).
        </li>
    </ul>

    <h4>🗄️ 5. Операции с файлами и экспорт</h4>
    <ul>
        <li>
            <button class="tool-btn file-save-btn">💾</button> <b>Сохранить данные (JSON):</b> Сохраняет все ваши блоки, словарный запас и текущий текст из редактора в файл <code>.json</code> на вашем компьютере. Это ваш основной способ резервного копирования и перемещения работы между сессиями.
        </li>
        <li>
            <button class="tool-btn file-load-btn">📂</button> <b>Загрузить данные (JSON):</b> Загружает данные из ранее сохраненного файла <code>.json</code>. <b>Внимание:</b> Это перезапишет вашу текущую работу! Вы будете запрошены на подтверждение.
        </li>
        <li>
            <button class="tool-btn preview-new-tab-btn">👁️</button> <b>Предварительный просмотр в новой вкладке:</b> Открывает текущий отформатированный контент в новой вкладке браузера. Это позволяет увидеть вашу работу в чистом виде, со всеми стилями, как если бы это был готовый HTML-файл.
        </li>
        <li>
            <button class="tool-btn save-btn">💾 HTML</button> <b>Экспорт в HTML:</b> Экспортирует весь отформатированный контент (все блоки и словарный запас) как полностью автономный файл <code>.html</code>. Этот файл можно открыть в любом браузере и поделиться им.
        </li>
    </ul>

    <h4>⚙️ 6. Общие функции и управление</h4>
    <ul>
        <li>
            <b>Автосохранение:</b> Ваша работа автоматически сохраняется в локальное хранилище вашего браузера каждые несколько секунд и при каждом значительном изменении. Это означает, что при закрытии и повторном открытии вкладки ваш последний прогресс будет восстановлен.
        </li>
        <li>
            <b>Отмена (Ctrl+Z):</b> Вы можете отменить свои последние действия (создание, удаление, редактирование блоков и т.д.) с помощью <code>Ctrl + Z</code> (или <code>Cmd + Z</code> на Mac).
        </li>
        <li>
            <button class="clear-btn">Очистить все</button> <b>Очистить все:</b> Удаляет все блоки, словарный запас и текст редактора. Это действие необратимо (если не отменено немедленно через Ctrl+Z) и требует подтверждения.
        </li>
        <li>
            <b>Элементы управления блоками:</b> Каждый блок в предварительном просмотре имеет небольшие элементы управления в правом верхнем углу (видимы при наведении курсора на блок):
            <ul>
                <li><span class="block-number" style="background-color: #e0e0e0; padding: 3px 6px; border-radius: 3px; font-size: 0.8em; color: #7f8c8d;">#N</span>: Отображает текущий номер блока. Нажмите на него, чтобы вручную переместить блок на новую позицию (вам будет предложено ввести номер).</li>
                <li><button class="edit-btn" style="width: 28px; height: 28px; font-size: 0.9em; border-radius: 50%; background: var(--primary-gradient); color: white;">✏️</button>: Редактирует содержимое блока в модальном окне.</li>
                <li><button class="delete-btn" style="width: 28px; height: 28px; font-size: 0.9em; border-radius: 50%; background: var(--danger-gradient); color: white;">×</button>: Удаляет блок после подтверждения.</li>
            </ul>
        </li>
        <li>
            <b>Переупорядочивание перетаскиванием (Drag & Drop):</b> Вы можете изменять порядок блоков в предварительном просмотре, кликая и перетаскивая их в новое место.
        </li>
        <li>
            <b>Подсветка:</b> Вновь созданные, отредактированные или перемещенные блоки будут кратковременно подсвечиваться синим цветом в предварительном просмотре, чтобы помочь вам их найти.
        </li>
        <li>
            <b>Адаптивный дизайн:</b> Редактор адаптируется к различным размерам экрана, что делает его удобным для использования на разных устройствах, включая мобильные.
        </li>
    </ul>

    <p>Наслаждайтесь созданием своих заметок по английскому языку!</p>
`;


// --- Main Event Listener ---
const initializeEditor = async () => {
    loadFromLocalStorage(); // Load auto-saved data on init

    document.getElementById('boldBtn').addEventListener('click', () => applyFormatting('b'));
    document.getElementById('italicBtn').addEventListener('click', () => applyFormatting('i'));
    document.getElementById('strikeBtn').addEventListener('click', () => applyFormatting('s'));
    document.getElementById('ruleBtn').addEventListener('click', (e) => handleBlockCreation(e, 'rule'));
    document.getElementById('dialogueBtn').addEventListener('click', (e) => handleBlockCreation(e, 'dialogue'));
    document.getElementById('exampleBtn').addEventListener('click', (e) => handleBlockCreation(e, 'example'));
    document.getElementById('centerBlockBtn').addEventListener('click', (e) => handleBlockCreation(e, 'centered'));
    document.getElementById('lineBtn').addEventListener('click', (e) => handleBlockCreation(e, 'separator', false));

    document.getElementById('headerBlockBtn').addEventListener('click', handleHeaderBlockCreation);
    document.getElementById('addVocabWordBtn').addEventListener('click', addVocabularyWord);

    // File save/load handlers
    document.getElementById('saveFileBtn').addEventListener('click', saveDataToFile);
    document.getElementById('loadFileBtn').addEventListener('click', loadDataFromFile);

    // Preview in New Tab button
    document.getElementById('previewInNewTabBtn').addEventListener('click', openPreviewInNewTab);

    document.getElementById('saveHtmlBtn').addEventListener('click', saveAsHTML);
    document.getElementById('clearBtn').addEventListener('click', async () => {
         if (confirm('Вы уверены, что хотите очистить все блоки и словарный запас? Это действие необратимо.')) {
            saveStateForUndo();
            allBlocks = []; vocabularyList = []; blockCounter = 0;
            editor.value = '';
            await renderPreview();
            autoSaveToLocalStorage();
         }
    });

    // Guide button handler
    document.getElementById('guideBtn').addEventListener('click', () => showHtmlModal('❓ Руководство по Редактору', GUIDE_HTML_CONTENT_RU));

    // --- Hotkey Listeners ---
    editor.addEventListener('keydown', (e) => {
        // Check if a modal is open
        if (document.querySelector('.modal-overlay')) {
            return; // Don't process hotkeys if a modal is active
        }

        // Ctrl+B for Bold
        if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
            e.preventDefault();
            applyFormatting('b');
        }
        // Ctrl+I for Italic
        if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
            e.preventDefault();
            applyFormatting('i');
        }
        // Ctrl+Shift+S for Strikethrough
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
            e.preventDefault();
            applyFormatting('s');
        }
        // Ctrl+Z for Undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undoLastAction();
        }
    });

    preview.addEventListener('click', async (e) => {
        const blockElement = e.target.closest('[data-type]');
        if (!blockElement) return;
        const id = blockElement.id;
        const type = blockElement.dataset.type;

        if (e.target.closest('.delete-btn')) {
            saveStateForUndo();
            if (confirm(`Вы уверены, что хотите удалить этот блок типа "${type}"?`)) {
                if (type === 'vocab') vocabularyList = vocabularyList.filter(v => v.id !== id);
                else allBlocks = allBlocks.filter(b => b.id !== id);
                await renderPreview();
                autoSaveToLocalStorage();
            }
        } else if (e.target.closest('.edit-btn')) {
            const block = allBlocks.find(b => b.id === id);
            // Edit button only for non-separator, non-vocabulary, non-header blocks
            if (!block || block.type === 'separator' || block.type === 'vocab' || block.type === 'markup-header') return;
            showEditModal(`Редактировать блок #${allBlocks.indexOf(block) + 1}`, block.content, async (newContent) => {
                saveStateForUndo();
                block.content = newContent;
                await renderPreview();
                highlightElement(id);
                autoSaveToLocalStorage();
            });
        }
        else if (e.target.closest('.dict-btn')) {
            const url = e.target.closest('.dict-btn').dataset.url;
            if (url) {
                window.open(url, '_blank');
            }
        }
        else if (e.target.closest('.block-number')) {
            allBlocks.sort((a, b) => a.order - b.order);
            const fromIndex = allBlocks.findIndex(b => b.id === id);
            const fromBlock = allBlocks[fromIndex];
            const newOrderStr = prompt(`Переместить блок #${fromIndex + 1}. Введите новую позицию (1 до ${allBlocks.length}).\nДобавьте '*' для перемещения ПОСЛЕ целевого блока (например, '3*' для перемещения после блока 3).\nНаберите '0' для перемещения в самый верх.`);
            if (!newOrderStr) return;

            let targetIndex;
            let insertAfter = false;

            if (newOrderStr === '0') {
                targetIndex = 0;
            } else if (newOrderStr.endsWith('*')) {
                insertAfter = true;
                targetIndex = parseInt(newOrderStr.slice(0, -1), 10) - 1;
            } else {
                targetIndex = parseInt(newOrderStr, 10) - 1;
            }

            if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= allBlocks.length && newOrderStr !== '0') {
                return alert('Неверный номер блока. Пожалуйста, введите число от 1 до ' + allBlocks.length + ' (или 0 для самого верха).');
            }

            if (targetIndex === fromIndex && !insertAfter) return;

            saveStateForUndo();
            let newOrder;
            if (newOrderStr === '0') {
                newOrder = allBlocks.length > 0 ? allBlocks[0].order - 1 : Date.now();
            } else if (insertAfter) {
                const targetBlock = allBlocks[targetIndex];
                const nextBlock = allBlocks[targetIndex + 1];
                newOrder = nextBlock ? (targetBlock.order + nextBlock.order) / 2 : targetBlock.order + 1;
            } else {
                const targetBlock = allBlocks[targetIndex];
                const prevBlock = allBlocks[targetIndex - 1];
                newOrder = prevBlock ? (prevBlock.order + targetBlock.order) / 2 : targetBlock.order - 1;
            }

            fromBlock.order = newOrder;
            await renderPreview();
            highlightElement(id);
            autoSaveToLocalStorage();
        }
    });

    // Add drag and drop event listeners to preview
    preview.addEventListener('dragstart', handleDragStart);
    preview.addEventListener('dragover', handleDragOver);
    preview.addEventListener('drop', handleDrop);

    renderPreview();
};

document.addEventListener('DOMContentLoaded', initializeEditor);