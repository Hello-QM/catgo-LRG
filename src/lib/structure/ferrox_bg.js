/**
 * Parameters for the adsorption site finder (WASM-compatible)
 */
export class JsAdsorptionSiteFinderParams {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(JsAdsorptionSiteFinderParams.prototype);
        obj.__wbg_ptr = ptr;
        JsAdsorptionSiteFinderParamsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsAdsorptionSiteFinderParamsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsadsorptionsitefinderparams_free(ptr, 0);
    }
    /**
     * Create default parameters
     */
    constructor() {
        const ret = wasm.jsadsorptionsitefinderparams_new();
        this.__wbg_ptr = ret >>> 0;
        JsAdsorptionSiteFinderParamsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set deduplication tolerance (Å). Default: 0.1
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withDedupTol(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withDedupTol(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set maximum bridge distance (Å). Default: 3.5
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withMaxBridgeDistance(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withMaxBridgeDistance(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set maximum hollow radius (Å). Default: 3.0
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withMaxHollowRadius(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withMaxHollowRadius(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set neighbor cutoff (Å). Default: 3.0
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withNeighborCutoff(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withNeighborCutoff(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set whether to only return upper surface sites. Default: true
     * @param {boolean} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withOnlyUpperSurface(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withOnlyUpperSurface(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set probe radius (Å). Default: 1.4
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withProbeRadius(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withProbeRadius(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set number of neighbors for signature. Default: 6
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withSignatureK(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withSignatureK(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set site height offset (Å). Default: 1.5
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withSiteHeightOffset(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withSiteHeightOffset(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
    /**
     * Set surface threshold (Å from z_max). Default: 2.5
     * @param {number} value
     * @returns {JsAdsorptionSiteFinderParams}
     */
    withSurfaceThreshold(value) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.jsadsorptionsitefinderparams_withSurfaceThreshold(ptr, value);
        return JsAdsorptionSiteFinderParams.__wrap(ret);
    }
}
if (Symbol.dispose) JsAdsorptionSiteFinderParams.prototype[Symbol.dispose] = JsAdsorptionSiteFinderParams.prototype.free;

/**
 * JavaScript-accessible Element wrapper.
 */
export class JsElement {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(JsElement.prototype);
        obj.__wbg_ptr = ptr;
        JsElementFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsElementFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jselement_free(ptr, 0);
    }
    /**
     * Get the atomic mass in atomic mass units.
     * @returns {number}
     */
    get atomicMass() {
        const ret = wasm.jselement_atomicMass(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the atomic number.
     * @returns {number}
     */
    get atomicNumber() {
        const ret = wasm.jselement_atomicNumber(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get atomic radius in Angstroms (or NaN if not defined).
     * @returns {number}
     */
    get atomicRadius() {
        const ret = wasm.jselement_atomicRadius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the periodic table block ("S", "P", "D", or "F").
     * @returns {string}
     */
    get block() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jselement_block(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get common oxidation states as a JavaScript array.
     * @returns {Int8Array}
     */
    commonOxidationStates() {
        const ret = wasm.jselement_commonOxidationStates(this.__wbg_ptr);
        var v1 = getArrayI8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get covalent radius in Angstroms (or NaN if not defined).
     * @returns {number}
     */
    get covalentRadius() {
        const ret = wasm.jselement_covalentRadius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the Pauling electronegativity (or NaN if not defined).
     * @returns {number}
     */
    get electronegativity() {
        const ret = wasm.jselement_electronegativity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create an element from its atomic number.
     *
     * Accepts 1-118 for real elements, plus pseudo-elements:
     * - 119: Dummy (placeholder atom)
     * - 120: D (Deuterium)
     * - 121: T (Tritium)
     * @param {number} z
     * @returns {JsElement}
     */
    static fromAtomicNumber(z) {
        const ret = wasm.jselement_fromAtomicNumber(z);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return JsElement.__wrap(ret[0]);
    }
    /**
     * Get the periodic table group (1-18).
     * @returns {number}
     */
    get group() {
        const ret = wasm.jselement_group(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get ICSD oxidation states (with at least 10 instances in ICSD) as a JavaScript array.
     * @returns {Int8Array}
     */
    icsdOxidationStates() {
        const ret = wasm.jselement_icsdOxidationStates(this.__wbg_ptr);
        var v1 = getArrayI8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get ionic radius for a specific oxidation state (or NaN if not defined).
     * @param {number} oxidation_state
     * @returns {number}
     */
    ionicRadius(oxidation_state) {
        const ret = wasm.jselement_ionicRadius(this.__wbg_ptr, oxidation_state);
        return ret;
    }
    /**
     * Check if element is an actinoid.
     * @returns {boolean}
     */
    isActinoid() {
        const ret = wasm.jselement_isActinoid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is an alkali metal.
     * @returns {boolean}
     */
    isAlkali() {
        const ret = wasm.jselement_isAlkali(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is an alkaline earth metal.
     * @returns {boolean}
     */
    isAlkaline() {
        const ret = wasm.jselement_isAlkaline(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a chalcogen.
     * @returns {boolean}
     */
    isChalcogen() {
        const ret = wasm.jselement_isChalcogen(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a halogen.
     * @returns {boolean}
     */
    isHalogen() {
        const ret = wasm.jselement_isHalogen(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a lanthanoid.
     * @returns {boolean}
     */
    isLanthanoid() {
        const ret = wasm.jselement_isLanthanoid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a metal.
     * @returns {boolean}
     */
    isMetal() {
        const ret = wasm.jselement_isMetal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a metalloid.
     * @returns {boolean}
     */
    isMetalloid() {
        const ret = wasm.jselement_isMetalloid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a noble gas.
     * @returns {boolean}
     */
    isNobleGas() {
        const ret = wasm.jselement_isNobleGas(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a post-transition metal.
     * @returns {boolean}
     */
    isPostTransitionMetal() {
        const ret = wasm.jselement_isPostTransitionMetal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if this is a pseudo-element (Dummy, D, T).
     * @returns {boolean}
     */
    isPseudo() {
        const ret = wasm.jselement_isPseudo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is radioactive.
     * @returns {boolean}
     */
    isRadioactive() {
        const ret = wasm.jselement_isRadioactive(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a rare earth element.
     * @returns {boolean}
     */
    isRareEarth() {
        const ret = wasm.jselement_isRareEarth(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a transition metal.
     * @returns {boolean}
     */
    isTransitionMetal() {
        const ret = wasm.jselement_isTransitionMetal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get maximum oxidation state (or 0 if none).
     * @returns {number}
     */
    get maxOxidationState() {
        const ret = wasm.jselement_maxOxidationState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get minimum oxidation state (or 0 if none).
     * @returns {number}
     */
    get minOxidationState() {
        const ret = wasm.jselement_minOxidationState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the full element name.
     * @returns {string}
     */
    get name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jselement_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Create an element from its symbol (e.g., "Fe", "O", "Na").
     *
     * Also accepts pseudo-elements: "D" (Deuterium), "T" (Tritium),
     * and "X"/"Dummy"/"Vac" (placeholder atom).
     * @param {string} symbol
     */
    constructor(symbol) {
        const ptr0 = passStringToWasm0(symbol, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.jselement_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsElementFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get oxidation states as a JavaScript array.
     * @returns {Int8Array}
     */
    oxidationStates() {
        const ret = wasm.jselement_oxidationStates(this.__wbg_ptr);
        var v1 = getArrayI8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get the periodic table row (1-7).
     * @returns {number}
     */
    get row() {
        const ret = wasm.jselement_row(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get Shannon ionic radius (or NaN if not defined).
     * @param {number} oxidation_state
     * @param {string} coordination
     * @param {string} spin
     * @returns {number}
     */
    shannonIonicRadius(oxidation_state, coordination, spin) {
        const ptr0 = passStringToWasm0(coordination, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(spin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.jselement_shannonIonicRadius(this.__wbg_ptr, oxidation_state, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Get the element symbol.
     * @returns {string}
     */
    get symbol() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jselement_symbol(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) JsElement.prototype[Symbol.dispose] = JsElement.prototype.free;

/**
 * JavaScript-accessible Species wrapper.
 */
export class JsSpecies {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsSpeciesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsspecies_free(ptr, 0);
    }
    /**
     * Get the element's atomic number.
     * @returns {number}
     */
    get atomicNumber() {
        const ret = wasm.jsspecies_atomicNumber(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get atomic radius (or NaN if not defined).
     * @returns {number}
     */
    get atomicRadius() {
        const ret = wasm.jsspecies_atomicRadius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get covalent radius (or NaN if not defined).
     * @returns {number}
     */
    get covalentRadius() {
        const ret = wasm.jsspecies_covalentRadius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get electronegativity (or NaN if not defined).
     * @returns {number}
     */
    get electronegativity() {
        const ret = wasm.jsspecies_electronegativity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get ionic radius for this species' oxidation state (or NaN if not defined).
     * @returns {number}
     */
    get ionicRadius() {
        const ret = wasm.jsspecies_ionicRadius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the element's full name (e.g., "Iron" for Fe).
     * @returns {string}
     */
    get name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jsspecies_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Create a species from a string like "Fe2+", "O2-", "Na+".
     * @param {string} species_str
     */
    constructor(species_str) {
        const ptr0 = passStringToWasm0(species_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.jsspecies_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsSpeciesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the oxidation state (or null/undefined if not set).
     * @returns {number | undefined}
     */
    get oxidationState() {
        const ret = wasm.jsspecies_oxidationState(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * Get Shannon ionic radius with coordination and spin (or NaN if not defined).
     * @param {string} coordination
     * @param {string} spin
     * @returns {number}
     */
    shannonIonicRadius(coordination, spin) {
        const ptr0 = passStringToWasm0(coordination, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(spin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.jsspecies_shannonIonicRadius(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Get the element symbol.
     * @returns {string}
     */
    get symbol() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jsspecies_symbol(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get the species string representation (e.g., "Fe2+").
     * @returns {string}
     */
    toString() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jsspecies_toString(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) JsSpecies.prototype[Symbol.dispose] = JsSpecies.prototype.free;

/**
 * Find adsorption sites on a catalyst surface.
 *
 * Takes a pymatgen-style structure JSON and returns the found sites.
 * Returns { ok: AdsorptionSiteResult } on success for TypeScript compatibility.
 * @param {any} structure_js
 * @param {JsAdsorptionSiteFinderParams | null} [params]
 * @returns {any}
 */
export function findAdsorptionSites(structure_js, params) {
    let ptr0 = 0;
    if (!isLikeNone(params)) {
        _assertClass(params, JsAdsorptionSiteFinderParams);
        ptr0 = params.__destroy_into_raw();
    }
    const ret = wasm.findAdsorptionSites(structure_js, ptr0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Find adsorption sites with default parameters.
 * @param {any} structure_js
 * @returns {any}
 */
export function findAdsorptionSitesDefault(structure_js) {
    const ret = wasm.findAdsorptionSitesDefault(structure_js);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}
export function __wbg_Error_8c4e43fe74559d73(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
}
export function __wbg___wbindgen_debug_string_0bc8482c6e3508ae(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_string_get_72fb696202c56729(arg0, arg1) {
    const obj = arg1;
    const ret = typeof(obj) === 'string' ? obj : undefined;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
}
export function __wbg___wbindgen_throw_be289d5034ed271b(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
}
export function __wbg_log_6b5ca2e6124b2808(arg0) {
    console.log(arg0);
}
export function __wbg_parse_708461a1feddfb38() { return handleError(function (arg0, arg1) {
    const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
    return ret;
}, arguments); }
export function __wbg_stringify_8d1cc6ff383e8bae() { return handleError(function (arg0) {
    const ret = JSON.stringify(arg0);
    return ret;
}, arguments); }
export function __wbindgen_cast_0000000000000001(arg0, arg1) {
    // Cast intrinsic for `Ref(String) -> Externref`.
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
}
export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
}
const JsAdsorptionSiteFinderParamsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsadsorptionsitefinderparams_free(ptr >>> 0, 1));
const JsElementFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jselement_free(ptr >>> 0, 1));
const JsSpeciesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsspecies_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedInt8ArrayMemory0 = null;
function getInt8ArrayMemory0() {
    if (cachedInt8ArrayMemory0 === null || cachedInt8ArrayMemory0.byteLength === 0) {
        cachedInt8ArrayMemory0 = new Int8Array(wasm.memory.buffer);
    }
    return cachedInt8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;


let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}
