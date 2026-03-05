// ==========================================
// IndexedDB Setup & State Management
// ==========================================
const DB_NAME = "MunbynScannerDB";
const DB_VERSION = 1;
let db = null;

// Temporary active state for the UI
let activeSession = null; // { id, recipeName, targetPallets, palletsScanned: [{barcode, materials: []}], ... }
let currentPalletBarcode = null;
let currentPalletMaterials = []; // Tracks scans against the active recipe
let currentPalletUsedUniqueIds = []; // Tracks 4-digit unique IDs scanned in the active pallet

let scanBuffer = "";
let lastKeyTime = 0;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const database = e.target.result;

            // 1. Materials Store: 3-digit Code -> Name
            if (!database.objectStoreNames.contains('materials')) {
                database.createObjectStore('materials', { keyPath: 'materialCode' });
            }

            // 2. Recipes Store: Name -> Array of { materialCode, targetQuantity }
            if (!database.objectStoreNames.contains('recipes')) {
                database.createObjectStore('recipes', { keyPath: 'recipeName' });
            }

            // 3. Batching Sessions Store
            if (!database.objectStoreNames.contains('sessions')) {
                database.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
            }

            // 4. History Logs
            if (!database.objectStoreNames.contains('history')) {
                database.createObjectStore('history', { keyPath: 'logId', autoIncrement: true });
            }
        };

        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };

        request.onerror = (e) => {
            console.error("IndexedDB Error:", e);
            reject(e);
        };
    });
}

// ==========================================
// UI ELEMENTS
// ==========================================
const views = {
    setup: document.getElementById('view-setup'),         // The Hub
    preBatching: document.getElementById('view-pre-batching'),
    editBom: document.getElementById('view-edit-bom'),
    materialsAdmin: document.getElementById('view-materials-admin'),
    scanPallet: document.getElementById('view-scan-pallet'),
    verify: document.getElementById('view-verify'),
    history: document.getElementById('view-history')
};

const navBtns = document.querySelectorAll('.nav-btn');
const hubBtns = document.querySelectorAll('.action-hub-btn');

// PIN Overlay
const pinOverlay = document.getElementById('overlay-pin');
const pinInput = document.getElementById('admin-pin-input');
const pinCancelBtn = document.getElementById('pin-cancel-btn');
const pinSubmitBtn = document.getElementById('pin-submit-btn');
const pinErrorMsg = document.getElementById('pin-error-msg');
const ADMIN_PIN = "1234"; // Hardcoded for prototype
let pendingAdminTarget = null;

// Materials UI
const addMaterialForm = document.getElementById('add-material-form');
const newMatCode = document.getElementById('new-mat-code');
const newMatName = document.getElementById('new-mat-name');
const saveMatBtn = document.getElementById('save-mat-btn');
const materialsListUI = document.getElementById('materials-list-ui');
const materialFormTitle = document.getElementById('material-form-title');
const cancelMatEditBtn = document.getElementById('cancel-mat-edit-btn');
let editingMaterialCode = null; // Tracks if we are editing vs creating

// Recipes UI
const recipesListUI = document.getElementById('recipes-list');
const showAddRecipeBtn = document.getElementById('show-add-recipe-btn');
const addRecipeForm = document.getElementById('add-recipe-form');
const recipeFormTitle = document.getElementById('recipe-form-title');
const cancelRecipeBtn = document.getElementById('cancel-recipe-btn');
const newRecipeName = document.getElementById('new-recipe-name');
const newRecipeMaterialsList = document.getElementById('new-recipe-materials-list');
const recipeAddMaterialSelect = document.getElementById('recipe-add-material-select');
const recipeAddQty = document.getElementById('recipe-add-qty');
const recipeAddMatBtn = document.getElementById('recipe-add-mat-btn');
const saveRecipeBtn = document.getElementById('save-recipe-btn');
let currentDraftRecipeItems = []; // { materialCode, targetQuantity, name }
let editingRecipeName = null;

// Sessions UI
const sessionRecipeSelect = document.getElementById('session-recipe-select');
const sessionTargetCount = document.getElementById('session-target-count');
const startSessionBtn = document.getElementById('start-session-btn');
const activeSessionInfo = document.getElementById('active-session-info');
const activeSessionDetails = document.getElementById('active-session-details');
const endSessionBtn = document.getElementById('end-session-btn');
const prebatchCurrentPalletInfo = document.getElementById('prebatch-current-pallet-info');
const prebatchPalletId = document.getElementById('prebatch-pallet-id');
const prebatchMaterialsList = document.getElementById('prebatch-materials-list');

// ==========================================
// SCANNER SIMULATOR
// ==========================================
const simForm = document.getElementById('sim-form');
const simInput = document.getElementById('sim-input');

const alertOverlay = document.getElementById('overlay-alert');
const alertIcon = document.getElementById('alert-icon');
const alertTitle = document.getElementById('alert-title');
const alertMessage = document.getElementById('alert-message');
const alertCloseBtn = document.getElementById('alert-close-btn');

// ==========================================
// CSV IMPORT
// ==========================================
const importCsvTriggerBtn = document.getElementById('import-csv-trigger-btn');
const csvFileInput = document.getElementById('csv-file-input');

// ==========================================
// NAVIGATION LOGIC
// ==========================================
function switchView(viewId) {
    if (!viewId) return;

    // Hide all views
    Object.values(views).forEach(view => {
        if (view) view.classList.remove('active');
    });
    // Show target
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    // Update bottom nav active state if it's a main nav item
    navBtns.forEach(btn => {
        if (btn.dataset.target === viewId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Handle special cases
    if (viewId === 'view-scan-pallet') {
        if (!activeSession) {
            showAlert("No Active Session", "Please start Pre-Batching first.", false);
            setTimeout(() => switchView('view-pre-batching'), 500);
        }
    } else if (viewId === 'view-history') {
        loadHistory();
    }
}

// Hub Navigation (Setup Tab buttons)
hubBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetView = btn.dataset.target;
        if (btn.classList.contains('pin-protected')) {
            showPinOverlay(targetView);
        } else {
            switchView(targetView);
        }
    });
});

if (importCsvTriggerBtn) {
    importCsvTriggerBtn.addEventListener('click', () => {
        showPinOverlay('action-import-csv');
    });
}

// Main Bottom Nav Navigation
navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // When clicking the primary Action/Setup tab explicitly, route to the hub
        if (btn.dataset.target === 'view-setup') {
            switchView('view-setup');
        } else {
            switchView(btn.dataset.target);
        }
    });
});

// Make switchView globally accessible for inline onclick handlers (close buttons)
window.switchView = switchView;

// ==========================================
// PIN PROTECTION LOGIC
// ==========================================
const pinDots = document.querySelectorAll('.pin-dot');
const numpadBtns = document.querySelectorAll('.numpad-btn');
const pinDelBtn = document.getElementById('pin-del-btn');
let currentPinEntry = "";

function updatePinDisplay() {
    pinDots.forEach((dot, index) => {
        if (index < currentPinEntry.length) {
            dot.classList.add('filled');
        } else {
            dot.classList.remove('filled');
        }
    });
}

function showPinOverlay(targetView) {
    pendingAdminTarget = targetView;
    currentPinEntry = "";
    updatePinDisplay();
    pinErrorMsg.classList.add('hidden');
    pinOverlay.classList.remove('hidden');
}

// Handle Custom Numpad
numpadBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (currentPinEntry.length < 4) {
            currentPinEntry += btn.dataset.val;
            updatePinDisplay();
            pinErrorMsg.classList.add('hidden');

            // Auto-submit on 4th digit
            if (currentPinEntry.length === 4) {
                // Short timeout to let the 4th dot fill visually before processing
                setTimeout(() => validatePin(), 150);
            }
        }
    });
});

pinDelBtn.addEventListener('click', () => {
    if (currentPinEntry.length > 0) {
        currentPinEntry = currentPinEntry.slice(0, -1);
        updatePinDisplay();
        pinErrorMsg.classList.add('hidden');
    }
});

pinCancelBtn.addEventListener('click', () => {
    pinOverlay.classList.add('hidden');
    pendingAdminTarget = null;
    currentPinEntry = "";
});

function validatePin() {
    if (currentPinEntry === ADMIN_PIN) {
        pinOverlay.classList.add('hidden');

        if (pendingAdminTarget === 'action-clear-history') {
            clearHistoryDB();
        } else if (pendingAdminTarget === 'action-import-csv') {
            if (csvFileInput) csvFileInput.click();
        } else if (pendingAdminTarget) {
            switchView(pendingAdminTarget);
        }

        pendingAdminTarget = null;
    } else {
        pinErrorMsg.classList.remove('hidden');
        currentPinEntry = "";
        updatePinDisplay();
        // Vibrate on error if supported
        if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
    }
}

// Initialize App
initDB().then(() => {
    console.log("IndexedDB Initialized successfully.");
    // Load lists into UI
    loadMaterialsList();
    loadRecipesList();
    // loadSessionsList();
}).catch(err => {
    showAlert("Database Error", "Failed to initialize local storage.", false);
});

// ==========================================
// DATA MANAGEMENT (IndexedDB wrappers & UI Binds)
// ==========================================

// --- Materials ---
addMaterialForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = newMatCode.value.trim();
    const name = newMatName.value.trim();
    if (code && name) {
        if (editingMaterialCode && code !== editingMaterialCode) {
            // They changed the code/ID. Delete old one, create new.
            const tx = db.transaction('materials', 'readwrite');
            tx.objectStore('materials').delete(editingMaterialCode);
            tx.objectStore('materials').put({ materialCode: code, name: name });
            tx.oncomplete = () => {
                resetMaterialForm();
                loadMaterialsList();
            }
        } else {
            // Standard add/update
            addMaterial(code, name);
        }
    }
});

cancelMatEditBtn.addEventListener('click', () => {
    resetMaterialForm();
});

function resetMaterialForm() {
    editingMaterialCode = null;
    newMatCode.value = '';
    newMatName.value = '';
    materialFormTitle.textContent = "Add New Material";
    saveMatBtn.textContent = "Add";
    cancelMatEditBtn.classList.add('hidden');
    newMatCode.focus();
}

function addMaterial(code, name) {
    const tx = db.transaction('materials', 'readwrite');
    tx.objectStore('materials').put({ materialCode: code, name: name });
    tx.oncomplete = () => {
        resetMaterialForm();
        loadMaterialsList();
    };
}

function deleteMaterial(code) {
    if (confirm(`Are you sure you want to delete material ${code}?`)) {
        const tx = db.transaction('materials', 'readwrite');
        tx.objectStore('materials').delete(code);
        tx.oncomplete = () => loadMaterialsList();
    }
}

window.editMaterial = (code, name) => {
    editingMaterialCode = code;
    newMatCode.value = code;
    newMatName.value = name;
    materialFormTitle.textContent = "Edit Material";
    saveMatBtn.textContent = "Save Changes";
    cancelMatEditBtn.classList.remove('hidden');
    newMatName.focus();
};

window.deleteMaterialAction = (code) => {
    deleteMaterial(code);
};

function loadMaterialsList() {
    const tx = db.transaction('materials', 'readonly');
    const store = tx.objectStore('materials');
    const request = store.getAll();

    request.onsuccess = () => {
        const materials = request.result;
        materialsListUI.innerHTML = '';
        recipeAddMaterialSelect.innerHTML = '<option value="">-- Select --</option>';

        if (materials.length === 0) {
            materialsListUI.innerHTML = '<p class="text-secondary text-center text-sm">No materials added yet.</p>';
            return;
        }

        materials.forEach(mat => {
            // Add to list
            const div = document.createElement('div');
            div.className = 'db-item';
            div.innerHTML = `
                <div style="flex-grow: 1;"><strong>${mat.materialCode}</strong>: ${mat.name}</div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn-icon" onclick="editMaterial('${mat.materialCode}', '${mat.name}')" style="font-size: 1.2rem;">✏️</button>
                    <button class="btn-icon text-danger" onclick="deleteMaterialAction('${mat.materialCode}')" style="font-size: 1.25rem;">🗑️</button>
                </div>
            `;
            materialsListUI.appendChild(div);

            // Add to dropdown
            const opt = document.createElement('option');
            opt.value = mat.materialCode;
            opt.textContent = `${mat.materialCode} - ${mat.name}`;
            opt.dataset.name = mat.name;
            recipeAddMaterialSelect.appendChild(opt);
        });
    };
}

// --- Recipes ---
showAddRecipeBtn.addEventListener('click', () => {
    resetRecipeForm();
    addRecipeForm.classList.remove('hidden');
    showAddRecipeBtn.classList.add('hidden');
});

cancelRecipeBtn.addEventListener('click', () => {
    addRecipeForm.classList.add('hidden');
    showAddRecipeBtn.classList.remove('hidden');
});

function resetRecipeForm() {
    editingRecipeName = null;
    newRecipeName.value = '';
    currentDraftRecipeItems = [];
    renderDraftRecipeMaterials();
    recipeFormTitle.textContent = "Create New BOM";
    saveRecipeBtn.textContent = "Save BOM";
}

recipeAddMatBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const matCode = recipeAddMaterialSelect.value;
    const qty = parseInt(recipeAddQty.value, 10);
    const matName = recipeAddMaterialSelect.options[recipeAddMaterialSelect.selectedIndex]?.dataset?.name;

    if (!matCode || isNaN(qty) || qty < 1) return;

    // Check if already in draft
    const existing = currentDraftRecipeItems.find(i => i.materialCode === matCode);
    if (existing) {
        existing.targetQuantity += qty;
    } else {
        currentDraftRecipeItems.push({ materialCode: matCode, name: matName, targetQuantity: qty });
    }

    renderDraftRecipeMaterials();
    recipeAddMaterialSelect.value = '';
    recipeAddQty.value = 1;
});

function renderDraftRecipeMaterials() {
    newRecipeMaterialsList.innerHTML = '';
    if (currentDraftRecipeItems.length === 0) {
        newRecipeMaterialsList.innerHTML = '<p class="text-secondary">No items added.</p>';
        return;
    }

    currentDraftRecipeItems.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'db-item';
        div.innerHTML = `
            <span><strong>${item.targetQuantity}x</strong> [${item.materialCode}] ${item.name}</span>
            <button class="btn-icon" onclick="removeDraftItem(${index})">❌</button>
        `;
        newRecipeMaterialsList.appendChild(div);
    });
}

window.removeDraftItem = (index) => {
    currentDraftRecipeItems.splice(index, 1);
    renderDraftRecipeMaterials();
};

saveRecipeBtn.addEventListener('click', () => {
    const name = newRecipeName.value.trim();
    if (!name) {
        showAlert("Error", "Please enter a BOM name.", false);
        return;
    }
    if (currentDraftRecipeItems.length === 0) {
        showAlert("Error", "Please add at least one material to the BOM.", false);
        return;
    }

    if (editingRecipeName && name !== editingRecipeName) {
        // Name changed, delete old one
        const tx = db.transaction('recipes', 'readwrite');
        tx.objectStore('recipes').delete(editingRecipeName);
        tx.objectStore('recipes').put({ recipeName: name, items: currentDraftRecipeItems });
        tx.oncomplete = () => finishRecipeSave();
    } else {
        addRecipe(name, currentDraftRecipeItems);
    }
});

function finishRecipeSave() {
    resetRecipeForm();
    addRecipeForm.classList.add('hidden');
    showAddRecipeBtn.classList.remove('hidden');
    loadRecipesList();
}

function addRecipe(name, materialsList) {
    const tx = db.transaction('recipes', 'readwrite');
    tx.objectStore('recipes').put({ recipeName: name, items: materialsList });
    tx.oncomplete = () => finishRecipeSave();
}

function deleteRecipe(name) {
    if (confirm(`Are you sure you want to delete BOM '${name}'?`)) {
        const tx = db.transaction('recipes', 'readwrite');
        tx.objectStore('recipes').delete(name);
        tx.oncomplete = () => loadRecipesList();
    }
}

window.editRecipe = (name) => {
    // Fetch recipe to edit
    const tx = db.transaction('recipes', 'readonly');
    const req = tx.objectStore('recipes').get(name);
    req.onsuccess = () => {
        if (req.result) {
            editingRecipeName = req.result.recipeName;
            newRecipeName.value = req.result.recipeName;
            currentDraftRecipeItems = JSON.parse(JSON.stringify(req.result.items));

            recipeFormTitle.textContent = "Edit BOM";
            saveRecipeBtn.textContent = "Save Changes";

            renderDraftRecipeMaterials();
            showAddRecipeBtn.classList.add('hidden');
            addRecipeForm.classList.remove('hidden');
        }
    };
};

window.deleteRecipeAction = (name) => {
    deleteRecipe(name);
};

function loadRecipesList() {
    const tx = db.transaction('recipes', 'readonly');
    const store = tx.objectStore('recipes');
    const request = store.getAll();

    request.onsuccess = () => {
        const recipes = request.result;
        recipesListUI.innerHTML = '';
        sessionRecipeSelect.innerHTML = '<option value="">-- Select BOM --</option>';

        if (recipes.length === 0) {
            recipesListUI.innerHTML = '<p class="text-secondary text-center text-sm">No BOMs created yet.</p>';
            return;
        }

        recipes.forEach(recipe => {
            // Add to list
            const div = document.createElement('div');
            div.className = 'db-item';
            div.style.alignItems = 'flex-start'; // Align items to top since list can be tall

            const itemsHtml = recipe.items.map(item => `<span>${item.targetQuantity}x [${item.materialCode}] ${item.name}</span>`).join('<br>');
            div.innerHTML = `
                <div style="flex-grow: 1;">
                    <strong>${recipe.recipeName}</strong><br>
                    <small>${itemsHtml}</small>
                </div>
                <div style="display: flex; gap: 0.5rem; flex-shrink: 0;">
                    <button class="btn-icon" onclick="editRecipe('${recipe.recipeName.replace(/'/g, "\\'")}')" style="font-size: 1.2rem;">✏️</button>
                    <button class="btn-icon text-danger" onclick="deleteRecipeAction('${recipe.recipeName.replace(/'/g, "\\'")}')" style="font-size: 1.25rem;">🗑️</button>
                </div>
            `;
            recipesListUI.appendChild(div);

            // Add to session dropdown
            const opt = document.createElement('option');
            opt.value = recipe.recipeName;
            opt.textContent = recipe.recipeName;
            sessionRecipeSelect.appendChild(opt);
        });
    };
}

// --- Sessions ---
startSessionBtn.addEventListener('click', () => {
    const rawRecipe = sessionRecipeSelect.value;
    const targetPallets = parseInt(sessionTargetCount.value, 10);

    if (!rawRecipe || isNaN(targetPallets) || targetPallets < 1) {
        showAlert("Wait", "Select a valid recipe and target pallet count.", false);
        return;
    }

    // Fetch recipe first to ensure items load
    const tx = db.transaction('recipes', 'readonly');
    const store = tx.objectStore('recipes');
    const req = store.get(rawRecipe);

    req.onsuccess = () => {
        if (!req.result) {
            showAlert("Error", "Invalid recipe selected.", false);
            return;
        }
        startSessionDB(req.result, targetPallets);
    };
});

endSessionBtn.addEventListener('click', () => {
    if (!activeSession) return;
    if (confirm("Are you sure you want to end this session? Any incomplete pallet will be lost.")) {
        activeSession = null;
        currentPalletBarcode = null;
        currentPalletMaterials = [];
        updateSessionUI();
        switchView('view-setup');
    }
});

function startSessionDB(recipeObj, targetPallets) {
    const tx = db.transaction('sessions', 'readwrite');
    // deep copy the items array so we can mutate `scanned` safely per pallet
    const itemsCopy = JSON.parse(JSON.stringify(recipeObj.items));

    const session = {
        recipeName: recipeObj.recipeName,
        recipeItems: itemsCopy,
        targetPallets: targetPallets,
        startedAt: new Date().toISOString(),
        palletsScanned: [], // Array of pallet barcodes
        usedUniqueIds: [], // Array of 4-digit unique tails used in this session
        status: 'Active'
    };

    const req = tx.objectStore('sessions').add(session);
    req.onsuccess = (e) => {
        session.id = e.target.result;
        activeSession = session;

        currentPalletBarcode = null;
        currentPalletUsedUniqueIds = [];
        currentPalletMaterials = activeSession.recipeItems.map(item => ({
            ...item,
            scanned: 0 // Reset scan count for the new pallet
        }));

        updateSessionUI();
        switchView('view-verify');
        updateVerifyUI();
    };
}

function updateSessionUI() {
    if (activeSession) {
        document.getElementById('session-setup-card').querySelector('.form-group').classList.add('hidden');
        document.getElementById('session-setup-card').querySelectorAll('.form-group')[1].classList.add('hidden');
        startSessionBtn.classList.add('hidden');

        activeSessionInfo.classList.remove('hidden');
        activeSessionDetails.textContent = `Recipe: ${activeSession.recipeName} | Pallets: ${activeSession.palletsScanned.length}/${activeSession.targetPallets}`;

        document.getElementById('active-session-title').textContent = `Session: ${activeSession.recipeName} (${activeSession.palletsScanned.length}/${activeSession.targetPallets})`;

        if (currentPalletBarcode) {
            prebatchCurrentPalletInfo.classList.remove('hidden');
            prebatchPalletId.textContent = currentPalletBarcode;
            document.getElementById('manual-pallet-entry').classList.add('hidden');
        } else {
            prebatchCurrentPalletInfo.classList.add('hidden');
            prebatchPalletId.textContent = 'None';
            document.getElementById('manual-pallet-entry').classList.remove('hidden');
        }
    } else {
        document.getElementById('session-setup-card').querySelector('.form-group').classList.remove('hidden');
        document.getElementById('session-setup-card').querySelectorAll('.form-group')[1].classList.remove('hidden');
        startSessionBtn.classList.remove('hidden');
        activeSessionInfo.classList.add('hidden');
        document.getElementById('active-session-title').textContent = `Session: ---`;
        prebatchCurrentPalletInfo.classList.add('hidden');
    }
}

// ==========================================
// SCANNER SIMULATOR / MANUAL ENTRY
// ==========================================
// Manual Pallet Entry
document.getElementById('manual-pallet-btn').addEventListener('click', () => {
    const manualInput = document.getElementById('manual-pallet-input');
    const barcode = manualInput.value.trim();
    if (barcode) {
        handleScan(barcode);
    }
    manualInput.value = '';
});

// Manual Verification Panel Entry
document.getElementById('manual-verify-btn').addEventListener('click', () => {
    const manualInput = document.getElementById('manual-verify-input');
    const barcode = manualInput.value.trim();
    if (barcode) {
        handleScan(barcode);
    }
    manualInput.value = '';
});

// Simulator form submission (now only visible in Pre-Batching)
simForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const barcode = simInput.value.trim();
    if (barcode) {
        handleScan(barcode);
    }
    simInput.value = '';
    simInput.focus();
});

// Hardware Scanner Event Listener (Keyboard Wedge)
document.addEventListener('keydown', (e) => {
    // If the event targets an input field (like the simulator), ignore it to prevent double scans
    if (e.target.tagName.toLowerCase() === 'input') return;

    const currentTime = new Date().getTime();

    // Wedge scanners type very fast. If > 50ms between keystrokes, likely human typing.
    // Reset buffer if delay is too long.
    if (currentTime - lastKeyTime > 100) {
        scanBuffer = "";
    }

    if (e.key === 'Enter') {
        if (scanBuffer.length > 0) {
            // Process the complete scan
            handleScan(scanBuffer);
            scanBuffer = "";
            e.preventDefault();
        }
    } else if (e.key.length === 1) {
        // Collect characters
        scanBuffer += e.key;
    }

    lastKeyTime = currentTime;
});

// ==========================================
// SCAN LOGIC
// ==========================================
function handleScan(barcode) {
    console.log("Scanned:", barcode);

    if (!activeSession) {
        showAlert("No Active Session", "Please start a Batching Session before scanning.", false);
        return;
    }

    if (barcode.length !== 13) {
        showAlert("Invalid Barcode", "Barcodes must be exactly 13 digits.", false);
        return;
    }

    // Determine if Pallet or Material globally based on '009' prefix
    if (barcode.startsWith('009')) {
        // Pallet Scan
        // Check if pallet already exists in this session
        const hasPallet = activeSession.palletsScanned.some(p => {
            if (typeof p === 'string') return p === barcode;
            return p.barcode === barcode;
        });

        if (hasPallet) {
            showAlert("Duplicate Pallet", `The pallet '${barcode}' has already been verified!`, false);
            return;
        }

        // If a pallet is already active, effectively "save" it before starting the new one
        if (currentPalletBarcode) {
            // Check if anything was scanned at all on the active pallet
            const totalScanned = currentPalletMaterials.reduce((sum, m) => sum + m.scanned, 0);

            const isComplete = currentPalletMaterials.every(m => m.scanned >= m.targetQuantity);
            if (!isComplete && totalScanned > 0) {
                if (!confirm(`Warning: Pallet ${currentPalletBarcode} is incomplete. Save anyway and switch to new pallet?`)) {
                    return; // user cancelled the swap
                }
            }

            // Save the old pallet
            activeSession.palletsScanned.push({
                barcode: currentPalletBarcode,
                materials: JSON.parse(JSON.stringify(currentPalletMaterials))
            });
            activeSession.usedUniqueIds.push(...currentPalletUsedUniqueIds);

            // Update DB for old pallet
            const tx = db.transaction('sessions', 'readwrite');
            tx.objectStore('sessions').put(activeSession);

            // Note: We don't mark session complete here immediately because they are scanning a new pallet, 
            // which implies the session isn't over yet (unless they just hit the target).
            // If they hit the target with the PREVIOUS pallet, tell them.
            if (activeSession.palletsScanned.length >= activeSession.targetPallets) {
                showAlert("Session Complete", "You have already reached the target pallet count for this session!", true);
                activeSession.status = 'Completed';
                const tx2 = db.transaction('sessions', 'readwrite');
                tx2.objectStore('sessions').put(activeSession);
                activeSession = null;
                updateSessionUI();
                switchView('view-setup');
                return;
            }
        }

        // Initialize the NEW pallet
        currentPalletBarcode = barcode;
        currentPalletUsedUniqueIds = [];
        currentPalletMaterials = activeSession.recipeItems.map(item => ({
            ...item,
            scanned: 0
        }));

        updateVerifyUI();
        updateSessionUI();

        // Brief visual confirmation
        const tail = barcode.substring(9, 13);
        showTempPopup(`Pallet ${tail} Active`, 1000);

    } else {
        // Material Scan
        if (!currentPalletBarcode) {
            showAlert("Scan Pallet First", "Please scan a Pallet barcode (starts with 009) before scanning materials.", false);
            return;
        }
        processMaterialScan(barcode);
    }
}

function processMaterialScan(barcode) {
    if (barcode.length !== 13) {
        showAlert("Invalid Barcode", "Material barcode must be exactly 13 digits.", false);
        return;
    }

    const matCode = barcode.substring(0, 3);
    const weight = barcode.substring(3, 9);
    const uniqueId = barcode.substring(9, 13);

    // Check global session uniqueness
    if (activeSession.usedUniqueIds.includes(uniqueId)) {
        showAlert("Duplicate Material", `This specific material unit (ID: ${uniqueId}) has already been packed on a previous pallet in this session!`, false);
        return;
    }
    // Check active pallet uniqueness
    if (currentPalletUsedUniqueIds.includes(uniqueId)) {
        showAlert("Duplicate Material", `You already scanned this exact material unit (ID: ${uniqueId}) on this pallet!`, false);
        return;
    }

    // Look up the material down to its first 3 digits
    const matIndex = currentPalletMaterials.findIndex(m => m.materialCode === matCode);

    if (matIndex === -1) {
        // The material is not in the recipe at all
        showAlert("Wrong Material!", `Material code '${matCode}' is not part of the '${activeSession.recipeName}' recipe!`, false);
        return;
    }

    const mat = currentPalletMaterials[matIndex];

    if (mat.scanned >= mat.targetQuantity) {
        // Already scanned enough
        showAlert("Over-scan!", `You have already scanned all required units for ${mat.name}.`, false);
        return;
    }

    // Increment scanned
    mat.scanned++;
    currentPalletUsedUniqueIds.push(uniqueId);
    updateVerifyUI();
}

function updateVerifyUI() {
    const listContainer = document.getElementById('materials-list');
    listContainer.innerHTML = '';
    prebatchMaterialsList.innerHTML = ''; // Also clear Pre-Batching list

    let totalTarget = 0;
    let totalScanned = 0;

    currentPalletMaterials.forEach(mat => {
        totalTarget += mat.targetQuantity;
        totalScanned += mat.scanned;

        const isComplete = mat.scanned === mat.targetQuantity;

        const el = document.createElement('div');
        el.className = `material-item ${isComplete ? 'complete' : ''}`;
        el.innerHTML = `
            <div class="material-info">
                <h3 style="margin: 0; font-size: 1.1rem;">${mat.name}</h3>
            </div>
            <div class="material-count">${mat.scanned} / ${mat.targetQuantity}</div>
        `;
        listContainer.appendChild(el);

        // Pre-Batching Tracker Item
        const pbEl = document.createElement('div');
        pbEl.className = 'db-item';
        pbEl.innerHTML = `
            <div style="flex-grow: 1;"><strong>${mat.name}</strong> <span class="text-secondary">[${mat.materialCode}]</span></div>
            <div class="${isComplete ? 'text-success' : 'text-danger'}" style="font-weight: bold;">
                ${mat.scanned} / ${mat.targetQuantity}
            </div>
        `;
        prebatchMaterialsList.appendChild(pbEl);
    });

    // Update Progress Header
    document.getElementById('progress-text').textContent = `${totalScanned} / ${totalTarget} Items Scanned`;
    const percent = totalTarget > 0 ? (totalScanned / totalTarget) * 100 : 0;
    document.getElementById('progress-bar').style.width = `${percent}%`;

    const palletIdDisplay = document.getElementById('active-pallet-id');
    // Ensure Pre-batch UI reflects pallet
    if (activeSession && currentPalletBarcode) {
        prebatchCurrentPalletInfo.classList.remove('hidden');
        prebatchPalletId.textContent = currentPalletBarcode;

        const tail = currentPalletBarcode.substring(9, 13);
        palletIdDisplay.textContent = `Pallet ${tail} active`;
    } else if (activeSession) {
        prebatchCurrentPalletInfo.classList.remove('hidden');
        prebatchPalletId.textContent = "Scan pallet first";
        palletIdDisplay.textContent = "Scan pallet first";
    }
}

function checkPalletCompletion() {
    const isComplete = currentPalletMaterials.every(m => m.scanned >= m.targetQuantity);

    if (isComplete) {
        // Complete        // Save
        activeSession.palletsScanned.push({
            barcode: currentPalletBarcode,
            materials: JSON.parse(JSON.stringify(currentPalletMaterials))
        });
        activeSession.usedUniqueIds.push(...currentPalletUsedUniqueIds);
        updateSessionUI();

        let msg = `All materials for ${currentPalletBarcode} verified.`;
        let sessionFinished = false;

        if (activeSession.palletsScanned.length >= activeSession.targetPallets) {
            msg += " Batching Session Complete!";
            sessionFinished = true;
            logHistory(`Session: ${activeSession.recipeName}`, `Target Reached (${activeSession.targetPallets} Pallets)`, new Date().toLocaleString());

            // Update session in DB
            const tx = db.transaction('sessions', 'readwrite');
            activeSession.status = 'Completed';
            tx.objectStore('sessions').put(activeSession);
        }

        showAlert("Pallet Verified!", msg, true);

        // Reset state
        currentPalletBarcode = null;
        currentPalletMaterials = [];
        currentPalletUsedUniqueIds = [];

        // Go back to scanning next pallet or ending session
        setTimeout(() => {
            if (sessionFinished) {
                activeSession = null;
                updateSessionUI();
                switchView('view-setup');
            } else {
                switchView('view-scan-pallet');
            }
        }, 2500);
    }
}

// ==========================================
// UTILITIES (Alerts, History)
// ==========================================
function showAlert(title, message, isSuccess) {
    alertTitle.textContent = title;
    alertMessage.textContent = message;

    alertOverlay.className = `overlay-alert ${isSuccess ? 'success' : ''}`;
    // Force remove hidden just in case
    alertOverlay.classList.remove('hidden');

    alertIcon.textContent = isSuccess ? '✅' : '❌';

    // Beep sound alternative using built-in APIs if possible, or just visual
    if ("vibrate" in navigator && !isSuccess) {
        navigator.vibrate([200, 100, 200]);
    } else if ("vibrate" in navigator && isSuccess) {
        navigator.vibrate([100]);
    }

    // Dismiss logic
    if (isSuccess) {
        alertCloseBtn.textContent = 'Continue';
        alertCloseBtn.className = 'btn btn-success btn-block mt-2';
    } else {
        alertCloseBtn.textContent = 'Dismiss Error';
        alertCloseBtn.className = 'btn btn-danger btn-block mt-2';
    }
}

function showTempPopup(msg, duration, callback) {
    const popup = document.getElementById('temp-popup');
    document.getElementById('temp-popup-msg').textContent = msg;
    popup.classList.remove('hidden');
    setTimeout(() => {
        popup.classList.add('hidden');
        if (callback) callback();
    }, duration);
}

// Cancel active pallet
document.getElementById('cancel-pallet-btn').addEventListener('click', () => {
    if (confirm("Are you sure you want to clear the materials currently counted for this pallet?")) {
        currentPalletBarcode = null;
        currentPalletUsedUniqueIds = [];
        currentPalletMaterials.forEach(m => m.scanned = 0);
        updateVerifyUI();
    }
});

alertCloseBtn.addEventListener('click', () => {
    alertOverlay.classList.add('hidden');
    // Important: re-focus sim input if we are testing so we don't have to keep clicking
    simInput.focus();
});

// History Logger & Viewer
function loadHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';

    if (!db) return;

    const tx = db.transaction('sessions', 'readonly');
    const store = tx.objectStore('sessions');
    const request = store.getAll();

    request.onsuccess = () => {
        const sessions = request.result;
        if (!sessions || sessions.length === 0) {
            list.innerHTML = '<p class="text-secondary text-center">No history available.</p>';
            return;
        }

        // Sort newest first
        sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

        sessions.forEach(session => {
            const el = document.createElement('div');
            el.className = 'card mb-2 history-session-card';
            el.style.borderLeft = session.status === 'Completed' ? '4px solid var(--success)' : '4px solid var(--warning)';
            el.style.cursor = 'pointer';

            const dateStr = new Date(session.startedAt).toLocaleString();
            let palletsHtml = '';

            // Create a temporary array of pallets for display so we can include the currently active one
            let displayPallets = [];
            if (session.palletsScanned) {
                displayPallets = [...session.palletsScanned];
            }

            // If this is the active session and there is an unfinished pallet in progress, append it dynamically
            if (activeSession && session.id === activeSession.id && currentPalletBarcode) {
                displayPallets.push({
                    barcode: currentPalletBarcode,
                    materials: currentPalletMaterials,
                    isActive: true
                });
            }

            if (displayPallets.length > 0) {
                palletsHtml = '<div class="history-pallets hidden" style="border-top: 1px solid var(--border-color); padding-top: 0.5rem; margin-top: 0.5rem;">';

                displayPallets.forEach((p, idx) => {
                    // Backward compatibility: if p is just a string, wrap it
                    const palletObj = typeof p === 'string' ? { barcode: p, materials: [] } : p;

                    const activeBadge = palletObj.isActive ? ' <span class="text-warning" style="font-size: 0.75rem; border: 1px solid var(--warning); padding: 0.1rem 0.3rem; border-radius: 4px; margin-left: 0.5rem;">ACTIVE (Unsaved)</span>' : '';

                    palletsHtml += `
                        <div class="mb-1" style="background: rgba(255,255,255,0.05); padding: 0.5rem; border-radius: 6px;">
                            <strong class="text-primary">Pallet ${idx + 1}:</strong> <span class="text-white">${palletObj.barcode}</span>${activeBadge}
                    `;

                    if (palletObj.materials && palletObj.materials.length > 0) {
                        palletsHtml += '<ul style="padding-left: 1.25rem; margin-top: 0.25rem; font-size: 0.85rem;" class="text-secondary">';

                        let hasScans = false;
                        palletObj.materials.forEach(mat => {
                            if (mat.scanned > 0 || !palletObj.isActive) {
                                hasScans = true;
                                const isMatComplete = mat.scanned >= mat.targetQuantity;
                                const colorClass = isMatComplete ? 'text-success' : 'text-warning';
                                palletsHtml += `<li>${mat.name}: <span class="${colorClass}">${mat.scanned}/${mat.targetQuantity}</span></li>`;
                            }
                        });

                        if (!hasScans && palletObj.isActive) {
                            palletsHtml += '<li style="list-style: none; margin-left: -1rem; padding-left: 0;">No materials scanned yet.</li>';
                        }

                        palletsHtml += '</ul>';
                    } else {
                        palletsHtml += '<p class="text-secondary m-0" style="font-size: 0.8rem;">No materials recorded.</p>';
                    }
                    palletsHtml += '</div>';
                });

                palletsHtml += '</div>';
            } else {
                palletsHtml = '<div class="history-pallets hidden"><p class="text-secondary mt-1 m-0" style="border-top: 1px solid var(--border-color); padding-top: 0.5rem;"><small>No pallets verified yet.</small></p></div>';
            }

            el.innerHTML = `
                <div style="display:flex; justify-content: space-between; align-items:flex-start;">
                    <h3 style="margin: 0; font-size: 1.1rem; color: var(--primary);">${session.recipeName}</h3>
                    <span class="text-${session.status === 'Completed' ? 'success' : 'warning'}" style="font-size: 0.85rem; font-weight: bold;">${session.status}</span>
                </div>
                <p class="text-secondary m-0 mt-1" style="font-size: 0.85rem;">Started: ${dateStr}</p>
                <div style="display:flex; justify-content: space-between; align-items: center; margin-top: 0.25rem;">
                    <p class="text-primary m-0" style="font-size: 0.85rem;">Progress: ${session.palletsScanned.length} / ${session.targetPallets} Pallets</p>
                    <span class="text-secondary toggle-icon" style="font-size: 1.2rem;">▼</span>
                </div>
                ${palletsHtml}
            `;

            // Add click listener to expand/collapse
            el.addEventListener('click', () => {
                const palletsContainer = el.querySelector('.history-pallets');
                const toggleIcon = el.querySelector('.toggle-icon');
                if (palletsContainer) {
                    palletsContainer.classList.toggle('hidden');
                    if (palletsContainer.classList.contains('hidden')) {
                        toggleIcon.textContent = '▼';
                        toggleIcon.classList.remove('text-primary');
                    } else {
                        toggleIcon.textContent = '▲';
                        toggleIcon.classList.add('text-primary');
                    }
                }
            });

            list.appendChild(el);
        });
    };
}

// History Logger (Legacy function for immediate UI feedback if needed)
function logHistory(palletId, status, timestamp) {
    // Mostly obsolete now that we rebuild from DB, but kept for legacy calls
}

// Reset DB Logic
document.getElementById('btn-clear-history').addEventListener('click', () => {
    showPinOverlay('action-clear-history');
});

function clearHistoryDB() {
    if (confirm("WARNING: This will permanently delete all session and scan history. Are you sure?")) {
        const tx = db.transaction(['sessions'], 'readwrite');
        tx.objectStore('sessions').clear();
        tx.oncomplete = () => {
            loadHistory();
            showAlert("Database Reset", "All history has been cleared.", true);

            // Also end any active session
            if (activeSession) {
                activeSession = null;
                currentPalletBarcode = null;
                currentPalletMaterials = [];
                currentPalletUsedUniqueIds = [];
                updateSessionUI();
            }
        };
        tx.onerror = () => {
            showAlert("Database Error", "Failed to clear history.", false);
        };
    }
}

// ==========================================
// CSV IMPORT LOGIC (FileReader)
// ==========================================
if (csvFileInput) {
    csvFileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        let processedCount = 0;

        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const text = ev.target.result;
                const fileName = file.name.toLowerCase();

                if (fileName.includes('material')) {
                    parseMaterialsCSV(text);
                } else if (fileName.includes('recipe')) {
                    parseRecipesCSV(text);
                }

                processedCount++;
                if (processedCount === files.length) {
                    setTimeout(() => {
                        showAlert('Import Complete', `Successfully imported ${files.length} CSV file(s).`, true);
                        if (typeof loadMaterialsList === 'function') loadMaterialsList();
                        if (typeof loadRecipesList === 'function') loadRecipesList();
                    }, 800);
                }
            };
            reader.readAsText(file);
        });

        csvFileInput.value = ''; // Reset input
    });
}

function parseMaterialsCSV(csvText) {
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) return; // Need at least header + 1 row

    const tx = db.transaction('materials', 'readwrite');
    const store = tx.objectStore('materials');

    // Start at 1 to skip header "MaterialCode,MaterialName"
    for (let i = 1; i < lines.length; i++) {
        // Handles basic CSV parsing without complex quoting
        const parts = lines[i].split(',').map(p => p.trim());
        if (parts.length >= 2) {
            const code = parts[0];
            const name = parts[1];
            if (code && name) {
                // Excel strips leading zeros, so force it back to 3 digits (e.g. "1" -> "001")
                const paddedCode = code.padStart(3, '0');
                store.put({ materialCode: paddedCode, name: name });
            }
        }
    }
}

function parseRecipesCSV(csvText) {
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) return;

    // Build a map of items for each recipe
    const recipeMap = {}; // { "Austin Core": { items: [] } }

    // Start at 1 to skip header "RecipeName,MaterialCode,TargetQuantity"
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        if (parts.length >= 3) {
            const recipeName = parts[0];
            const matCode = parts[1];
            const qty = parseInt(parts[2], 10);

            if (recipeName && matCode && !isNaN(qty)) {
                if (!recipeMap[recipeName]) {
                    recipeMap[recipeName] = [];
                }

                // Excel strips leading zeros, so force it back to 3 digits
                const paddedMatCode = matCode.padStart(3, '0');

                recipeMap[recipeName].push({
                    materialCode: paddedMatCode,
                    targetQuantity: qty,
                    name: "Imported Material" // Mocked until loaded
                });
            }
        }
    }

    const tx = db.transaction('recipes', 'readwrite');
    const store = tx.objectStore('recipes');

    Object.keys(recipeMap).forEach(key => {
        store.put({
            recipeName: key,
            items: recipeMap[key]
        });
    });
}
