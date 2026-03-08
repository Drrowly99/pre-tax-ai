/**
 * File Upload Logic and PDF Inspection
 */

document.addEventListener('DOMContentLoaded', () => {

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const fileListContainer = document.getElementById('file-list');
  const counterSpan = document.getElementById('upload-counter');
  const checkBtn = document.getElementById('btn-to-review');
  const emptyMsg = document.getElementById('empty-files-msg');

  // We maintain a global array to persist between views
  window._uploadedFileMeta = window._uploadedFileMeta || [];

  window.uploadMaxLimit = window.uploadMaxLimit || 6; // default fallback

  if (dropZone && fileInput) {
      
      // Prevent default drag behaviors
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
          dropZone.addEventListener(eventName, preventDefaults, false);
          document.body.addEventListener(eventName, preventDefaults, false);
      });

      // Highlight drop zone
      ['dragenter', 'dragover'].forEach(eventName => {
          dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
      });

      ['dragleave', 'drop'].forEach(eventName => {
          dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
      });

      // Handle dropped files
      dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files), false);
      
      // Handle clicked files
      fileInput.addEventListener('change', function() {
          handleFiles(this.files);
          this.value = ''; // reset
      });
  }

  function preventDefaults(e) {
      e.preventDefault();
      e.stopPropagation();
  }

  async function handleFiles(files) {
      const remainingSlots = window.uploadMaxLimit - window._uploadedFileMeta.length;
      
      if (remainingSlots <= 0) {
          window.showToast?.('error', `You've reached the maximum limit of ${window.uploadMaxLimit} files for this package.`);
          return;
      }

      // Convert to array and filter out non-PDFs
      const fileArr = [...files].filter(f => {
          if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
              window.showToast?.('error', `${f.name} is not a PDF. Only PDFs are allowed.`);
              return false;
          }
          return true;
      }).slice(0, remainingSlots);

      if (fileArr.length < files.length && remainingSlots > 0) {
          window.showToast?.('warning', `Only accepted first ${remainingSlots} PDF files.`);
      }

      for (let i = 0; i < fileArr.length; i++) {
          const file = fileArr[i];
          
          // Size check (max 15MB)
          if (file.size > 15 * 1024 * 1024) {
              window.showToast?.('error', `${file.name} is too large (max 15MB).`);
              continue;
          }

          // Check duplicate
          if (window._uploadedFileMeta.some(meta => meta.name === file.name && meta.size === file.size)) {
              window.showToast?.('warning', `${file.name} is already uploaded.`);
              continue;
          }

          // Generate safe ID
          const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
          
          const meta = {
              id: fileId,
              name: file.name,
              size: file.size,
              obj: file, // Keep reference to actual file for backend later
              pages: '?',
              status: 'scanning'
          };
          
          window._uploadedFileMeta.push(meta);
          renderFileItem(meta);
          
          // Process PDF asynchronously
          try {
              const numPages = await getPdfPageCount(file);
              meta.pages = numPages;
              meta.status = 'ready';
              updateFileItemRender(meta);
              
              if (numPages > 12) {
                  showPageWarning(fileId, numPages);
              }
          } catch (err) {
              console.error(err);
              meta.status = 'error';
              meta.pages = 'ERR';
              updateFileItemRender(meta);
              window.showToast?.('error', `Could not read ${file.name}. Is it password protected?`);
          }
      }
      
      updateGlobalUI();
  }

  async function getPdfPageCount(file) {
      // requires pdf.js
      if (!window.pdfjsLib) return '?';
      
      return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsArrayBuffer(file);
          reader.onload = async () => {
              try {
                  const typedarray = new Uint8Array(reader.result);
                  const pdf = await pdfjsLib.getDocument(typedarray).promise;
                  resolve(pdf.numPages);
              } catch (e) {
                  reject(e);
              }
          };
          reader.onerror = reject;
      });
  }

  function renderFileItem(meta) {
      if (emptyMsg) emptyMsg.style.display = 'none';
      
      const el = document.createElement('div');
      el.id = meta.id;
      el.className = 'flex items-center p-4 bg-white border border-gray-200 rounded-lg shadow-sm w-full transition-colors hover:border-tax-green/30';
      
      const sizeStr = (meta.size / 1024 / 1024).toFixed(2) + ' MB';
      
      let iconColor = 'text-gray-400';
      let iconSvg = `<svg class="w-8 h-8 ${iconColor}" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>`;
      
      let rightSide = `<svg class="w-5 h-5 animate-spin text-tax-green" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
      
      el.innerHTML = `
          <div class="mr-4">${iconSvg}</div>
          <div class="flex-grow min-w-0 pr-4">
              <h4 class="text-sm font-semibold text-gray-900 truncate" title="${meta.name}">${meta.name}</h4>
              <p class="text-xs text-gray-500 mt-0.5" id="${meta.id}-sub">${sizeStr} • Scanning pages...</p>
          </div>
          <div class="flex-shrink-0 flex items-center space-x-3" id="${meta.id}-actions">
              ${rightSide}
          </div>
      `;
      
      fileListContainer.appendChild(el);
  }

  function updateFileItemRender(meta) {
      const el = document.getElementById(meta.id);
      if (!el) return;
      
      const sub = document.getElementById(`${meta.id}-sub`);
      const actions = document.getElementById(`${meta.id}-actions`);
      
      const sizeStr = (meta.size / 1024 / 1024).toFixed(2) + ' MB';
      
      if (meta.status === 'ready') {
          sub.textContent = `${sizeStr} • ${meta.pages} pages`;
          actions.innerHTML = `
              <span class="text-xs font-medium text-tax-green bg-tax-green-light px-2 py-1 rounded hidden sm:inline-block">Ready to Scan</span>
              <button type="button" class="text-gray-400 hover:text-red-500 p-1 rounded-full hover:bg-red-50 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 delete-file" data-id="${meta.id}">
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
              </button>
          `;
          
          // Add listener to the new delete btn
          actions.querySelector('.delete-file').addEventListener('click', () => removeFile(meta.id));
      } else if (meta.status === 'error') {
          sub.innerHTML = `<span class="text-red-500 font-medium">Unreadable or password protected</span>`;
          actions.innerHTML = `
              <button type="button" class="text-gray-400 hover:text-red-500 p-1 rounded-full hover:bg-red-50 transition-colors focus:outline-none delete-file" data-id="${meta.id}">
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>
              </button>
          `;
          actions.querySelector('.delete-file').addEventListener('click', () => removeFile(meta.id));
      }
  }

  function removeFile(fileId) {
      window._uploadedFileMeta = window._uploadedFileMeta.filter(m => m.id !== fileId);
      const el = document.getElementById(fileId);
      if (el) {
          el.classList.add('opacity-0', '-translate-x-4');
          setTimeout(() => {
              el.remove();
              updateGlobalUI();
              if (window._uploadedFileMeta.length === 0 && emptyMsg) {
                  emptyMsg.style.display = 'block';
              }
          }, 200);
      } else {
          updateGlobalUI();
      }
  }

  window.validateCheckoutBtn = () => updateGlobalUI();

  function updateGlobalUI() {
      if (counterSpan) counterSpan.textContent = window._uploadedFileMeta.length;
      
      // Update check button state
      if (checkBtn) {
          const hasValidFiles = window._uploadedFileMeta.some(m => m.status === 'ready');
          checkBtn.disabled = !hasValidFiles;
          if (hasValidFiles) {
              checkBtn.classList.remove('opacity-50', 'cursor-not-allowed');
          } else {
              checkBtn.classList.add('opacity-50', 'cursor-not-allowed');
          }
      }
  }

  // --- Large PDF Warning System ---
  let activeWarnId = null;
  const warnModal = document.getElementById('page-warning-backdrop');
  
  function showPageWarning(fileId, counts) {
      activeWarnId = fileId;
      document.getElementById('warn-page-count').textContent = counts;
      if (warnModal) warnModal.classList.add('active');
  }

  document.getElementById('btn-warn-remove')?.addEventListener('click', () => {
      if (activeWarnId) removeFile(activeWarnId);
      if (warnModal) warnModal.classList.remove('active');
      activeWarnId = null;
  });

  document.getElementById('btn-warn-keep')?.addEventListener('click', () => {
      // User accepts risk
      if (warnModal) warnModal.classList.remove('active');
      activeWarnId = null;
  });

  // Start logic
  updateGlobalUI();

});
