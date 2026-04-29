/* @ts-self-types="./ferrox.d.ts" */

/**
 * FIRE optimizer state with cell optimization.
 */
export class JsCellFireState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsCellFireStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jscellfirestate_free(ptr, 0);
    }
    /**
     * Get cell matrix as flat array.
     * @returns {Float64Array}
     */
    get cell() {
        const ret = wasm.jscellfirestate_cell(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Check if optimization has converged.
     *
     * fmax: force convergence threshold (must be positive)
     * smax: stress convergence threshold (must be positive)
     * @param {number} fmax
     * @param {number} smax
     * @returns {boolean}
     */
    is_converged(fmax, smax) {
        const ret = wasm.jscellfirestate_is_converged(this.__wbg_ptr, fmax, smax);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Get maximum force component.
     * @returns {number}
     */
    max_force() {
        const ret = wasm.jscellfirestate_max_force(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get maximum stress component.
     * @returns {number}
     */
    max_stress() {
        const ret = wasm.jscellfirestate_max_stress(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create a new CellFIRE state.
     *
     * positions: flat array [x0, y0, z0, ...] in Angstrom
     * cell: 9-element cell matrix (row-major)
     * config: optional FIRE configuration
     * cell_factor: scaling factor for cell DOF (default: 1.0)
     *
     * Returns an error if positions length is not a multiple of 3 or cell is not 9 elements.
     * @param {Float64Array} positions
     * @param {Float64Array} cell
     * @param {JsFireConfig | null} [config]
     * @param {number | null} [cell_factor]
     */
    constructor(positions, cell, config, cell_factor) {
        const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        let ptr2 = 0;
        if (!isLikeNone(config)) {
            _assertClass(config, JsFireConfig);
            ptr2 = config.__destroy_into_raw();
        }
        const ret = wasm.jscellfirestate_new(ptr0, len0, ptr1, len1, ptr2, !isLikeNone(cell_factor), isLikeNone(cell_factor) ? 0 : cell_factor);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsCellFireStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of atoms.
     * @returns {number}
     */
    get num_atoms() {
        const ret = wasm.jscellfirestate_num_atoms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get positions as flat array.
     * @returns {Float64Array}
     */
    get positions() {
        const ret = wasm.jscellfirestate_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) JsCellFireState.prototype[Symbol.dispose] = JsCellFireState.prototype.free;

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
    get atomic_mass() {
        const ret = wasm.jselement_atomic_mass(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the atomic number.
     * @returns {number}
     */
    get atomic_number() {
        const ret = wasm.jselement_atomic_number(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get atomic radius in Angstroms (or NaN if not defined).
     * @returns {number}
     */
    get atomic_radius() {
        const ret = wasm.jselement_atomic_radius(this.__wbg_ptr);
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
     * Get boiling point in Kelvin (or NaN if not defined).
     * @returns {number}
     */
    get boiling_point() {
        const ret = wasm.jselement_boiling_point(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get common oxidation states as a JavaScript array.
     * @returns {Int8Array}
     */
    common_oxidation_states() {
        const ret = wasm.jselement_common_oxidation_states(this.__wbg_ptr);
        var v1 = getArrayI8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get covalent radius in Angstroms (or NaN if not defined).
     * @returns {number}
     */
    get covalent_radius() {
        const ret = wasm.jselement_covalent_radius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get density in g/cm³ (or NaN if not defined).
     * @returns {number}
     */
    get density() {
        const ret = wasm.jselement_density(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get electron affinity in kJ/mol (or NaN if not defined).
     * @returns {number}
     */
    get electron_affinity() {
        const ret = wasm.jselement_electron_affinity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get electron configuration string (or empty string if not defined).
     * @returns {string}
     */
    get electron_configuration() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jselement_electron_configuration(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get semantic electron configuration with noble gas core (or empty string if not defined).
     * @returns {string}
     */
    get electron_configuration_semantic() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jselement_electron_configuration_semantic(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
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
     * Get first ionization energy in kJ/mol (or NaN if not defined).
     * @returns {number}
     */
    get first_ionization_energy() {
        const ret = wasm.jselement_first_ionization_energy(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create an element from its atomic number.
     *
     * Accepts 1-118 for real elements, plus pseudo-elements:
     * - 119: Dummy (placeholder atom)
     * - 120: D (Deuterium)
     * - 121: T (Tritium)
     * @param {number} atomic_num
     * @returns {JsElement}
     */
    static from_atomic_number(atomic_num) {
        const ret = wasm.jselement_from_atomic_number(atomic_num);
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
    icsd_oxidation_states() {
        const ret = wasm.jselement_icsd_oxidation_states(this.__wbg_ptr);
        var v1 = getArrayI8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Get all ionic radii as JSON string: {"oxi_state": radius, ...}.
     *
     * Returns null if no ionic radii data is available.
     * @returns {string | undefined}
     */
    ionic_radii() {
        const ret = wasm.jselement_ionic_radii(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Get ionic radius for a specific oxidation state (or NaN if not defined).
     * @param {number} oxidation_state
     * @returns {number}
     */
    ionic_radius(oxidation_state) {
        const ret = wasm.jselement_ionic_radius(this.__wbg_ptr, oxidation_state);
        return ret;
    }
    /**
     * Get all ionization energies in kJ/mol.
     * @returns {Float64Array}
     */
    ionization_energies() {
        const ret = wasm.jselement_ionization_energies(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Check if element is an actinoid.
     * @returns {boolean}
     */
    is_actinoid() {
        const ret = wasm.jselement_is_actinoid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is an alkali metal.
     * @returns {boolean}
     */
    is_alkali() {
        const ret = wasm.jselement_is_alkali(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is an alkaline earth metal.
     * @returns {boolean}
     */
    is_alkaline() {
        const ret = wasm.jselement_is_alkaline(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a chalcogen.
     * @returns {boolean}
     */
    is_chalcogen() {
        const ret = wasm.jselement_is_chalcogen(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a halogen.
     * @returns {boolean}
     */
    is_halogen() {
        const ret = wasm.jselement_is_halogen(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a lanthanoid.
     * @returns {boolean}
     */
    is_lanthanoid() {
        const ret = wasm.jselement_is_lanthanoid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a metal.
     * @returns {boolean}
     */
    is_metal() {
        const ret = wasm.jselement_is_metal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a metalloid.
     * @returns {boolean}
     */
    is_metalloid() {
        const ret = wasm.jselement_is_metalloid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a noble gas.
     * @returns {boolean}
     */
    is_noble_gas() {
        const ret = wasm.jselement_is_noble_gas(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a post-transition metal.
     * @returns {boolean}
     */
    is_post_transition_metal() {
        const ret = wasm.jselement_is_post_transition_metal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if this is a pseudo-element (Dummy, D, T).
     * @returns {boolean}
     */
    is_pseudo() {
        const ret = wasm.jselement_is_pseudo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is radioactive.
     * @returns {boolean}
     */
    is_radioactive() {
        const ret = wasm.jselement_is_radioactive(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a rare earth element.
     * @returns {boolean}
     */
    is_rare_earth() {
        const ret = wasm.jselement_is_rare_earth(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if element is a transition metal.
     * @returns {boolean}
     */
    is_transition_metal() {
        const ret = wasm.jselement_is_transition_metal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get maximum oxidation state (or 0 if none).
     * @returns {number}
     */
    get max_oxidation_state() {
        const ret = wasm.jselement_max_oxidation_state(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get melting point in Kelvin (or NaN if not defined).
     * @returns {number}
     */
    get melting_point() {
        const ret = wasm.jselement_melting_point(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get minimum oxidation state (or 0 if none).
     * @returns {number}
     */
    get min_oxidation_state() {
        const ret = wasm.jselement_min_oxidation_state(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get molar heat capacity (Cp) in J/(mol·K) (or NaN if not defined).
     * @returns {number}
     */
    get molar_heat() {
        const ret = wasm.jselement_molar_heat(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get number of valence electrons (or 0 if not defined).
     * @returns {number}
     */
    get n_valence() {
        const ret = wasm.jselement_n_valence(this.__wbg_ptr);
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
    oxidation_states() {
        const ret = wasm.jselement_oxidation_states(this.__wbg_ptr);
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
    shannon_ionic_radius(oxidation_state, coordination, spin) {
        const ptr0 = passStringToWasm0(coordination, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(spin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.jselement_shannon_ionic_radius(this.__wbg_ptr, oxidation_state, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Get full Shannon radii as JSON string.
     *
     * Structure: {oxi_state: {coordination: {spin: {crystal_radius, ionic_radius}}}}
     * Returns null if no Shannon radii data is available.
     * @returns {string | undefined}
     */
    shannon_radii() {
        const ret = wasm.jselement_shannon_radii(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Get specific heat capacity in J/(g·K) (or NaN if not defined).
     * @returns {number}
     */
    get specific_heat() {
        const ret = wasm.jselement_specific_heat(this.__wbg_ptr);
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
 * FIRE optimizer configuration.
 */
export class JsFireConfig {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsFireConfigFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsfireconfig_free(ptr, 0);
    }
    /**
     * Create a new FIRE configuration with default parameters.
     */
    constructor() {
        const ret = wasm.jsfireconfig_new();
        this.__wbg_ptr = ret >>> 0;
        JsFireConfigFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set maximum timestep.
     * @param {number} dt_max
     */
    set_dt_max(dt_max) {
        wasm.jsfireconfig_set_dt_max(this.__wbg_ptr, dt_max);
    }
    /**
     * Set initial timestep.
     * @param {number} dt_start
     */
    set_dt_start(dt_start) {
        wasm.jsfireconfig_set_dt_start(this.__wbg_ptr, dt_start);
    }
    /**
     * Set maximum step size in Angstrom.
     * @param {number} max_step
     */
    set_max_step(max_step) {
        wasm.jsfireconfig_set_max_step(this.__wbg_ptr, max_step);
    }
    /**
     * Set minimum steps before dt increase.
     * @param {number} n_min
     */
    set_n_min(n_min) {
        wasm.jsfireconfig_set_n_min(this.__wbg_ptr, n_min);
    }
}
if (Symbol.dispose) JsFireConfig.prototype[Symbol.dispose] = JsFireConfig.prototype.free;

/**
 * FIRE optimizer state.
 */
export class JsFireState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsFireStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsfirestate_free(ptr, 0);
    }
    /**
     * Current timestep.
     * @returns {number}
     */
    get dt() {
        const ret = wasm.jsfirestate_dt(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if optimization has converged.
     * @param {number} fmax
     * @returns {boolean}
     */
    is_converged(fmax) {
        const ret = wasm.jsfirestate_is_converged(this.__wbg_ptr, fmax);
        return ret !== 0;
    }
    /**
     * Get maximum force component.
     * @returns {number}
     */
    max_force() {
        const ret = wasm.jsfirestate_max_force(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create a new FIRE state.
     *
     * positions: flat array [x0, y0, z0, ...] in Angstrom
     * config: optional FIRE configuration (uses defaults if not provided)
     *
     * Returns an error if positions length is not a multiple of 3.
     * @param {Float64Array} positions
     * @param {JsFireConfig | null} [config]
     */
    constructor(positions, config) {
        const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        let ptr1 = 0;
        if (!isLikeNone(config)) {
            _assertClass(config, JsFireConfig);
            ptr1 = config.__destroy_into_raw();
        }
        const ret = wasm.jsfirestate_new(ptr0, len0, ptr1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsFireStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of atoms.
     * @returns {number}
     */
    get num_atoms() {
        const ret = wasm.jsfirestate_num_atoms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get positions as flat array.
     * @returns {Float64Array}
     */
    get positions() {
        const ret = wasm.jsfirestate_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) JsFireState.prototype[Symbol.dispose] = JsFireState.prototype.free;

/**
 * Langevin dynamics integrator for NVT ensemble.
 */
export class JsLangevinIntegrator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsLangevinIntegratorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jslangevinintegrator_free(ptr, 0);
    }
    /**
     * Create a new Langevin integrator.
     *
     * temperature_k: target temperature in Kelvin (must be non-negative)
     * friction: friction coefficient in 1/fs (must be positive)
     * dt: timestep in femtoseconds (must be positive)
     * seed: optional RNG seed for reproducibility
     * @param {number} temperature_k
     * @param {number} friction
     * @param {number} dt
     * @param {bigint | null} [seed]
     */
    constructor(temperature_k, friction, dt, seed) {
        const ret = wasm.jslangevinintegrator_new(temperature_k, friction, dt, !isLikeNone(seed), isLikeNone(seed) ? BigInt(0) : seed);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsLangevinIntegratorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set timestep.
     * @param {number} dt
     */
    set_dt(dt) {
        wasm.jslangevinintegrator_set_dt(this.__wbg_ptr, dt);
    }
    /**
     * Set friction coefficient.
     * @param {number} friction
     */
    set_friction(friction) {
        wasm.jslangevinintegrator_set_friction(this.__wbg_ptr, friction);
    }
    /**
     * Set target temperature.
     * @param {number} temperature_k
     */
    set_temperature(temperature_k) {
        wasm.jslangevinintegrator_set_temperature(this.__wbg_ptr, temperature_k);
    }
}
if (Symbol.dispose) JsLangevinIntegrator.prototype[Symbol.dispose] = JsLangevinIntegrator.prototype.free;

/**
 * MD simulation state for WASM.
 */
export class JsMDState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsMDStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsmdstate_free(ptr, 0);
    }
    /**
     * Get forces as flat array.
     * @returns {Float64Array}
     */
    get forces() {
        const ret = wasm.jsmdstate_forces(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Initialize velocities from Maxwell-Boltzmann distribution.
     * @param {number} temperature_k
     * @param {bigint | null} [seed]
     */
    init_velocities(temperature_k, seed) {
        wasm.jsmdstate_init_velocities(this.__wbg_ptr, temperature_k, !isLikeNone(seed), isLikeNone(seed) ? BigInt(0) : seed);
    }
    /**
     * Compute kinetic energy in eV.
     * @returns {number}
     */
    kinetic_energy() {
        const ret = wasm.jsmdstate_kinetic_energy(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get masses.
     * @returns {Float64Array}
     */
    get masses() {
        const ret = wasm.jsmdstate_masses(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Create a new MD state.
     *
     * positions: flat array [x0, y0, z0, x1, y1, z1, ...] in Angstrom
     * masses: array of atomic masses in amu
     * @param {Float64Array} positions
     * @param {Float64Array} masses
     */
    constructor(positions, masses) {
        const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(masses, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.jsmdstate_new(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsMDStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of atoms.
     * @returns {number}
     */
    get num_atoms() {
        const ret = wasm.jsmdstate_num_atoms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get positions as flat array.
     * @returns {Float64Array}
     */
    get positions() {
        const ret = wasm.jsmdstate_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Set cell matrix (9 elements, row-major).
     * @param {Float64Array} cell
     * @param {boolean} pbc_x
     * @param {boolean} pbc_y
     * @param {boolean} pbc_z
     */
    set_cell(cell, pbc_x, pbc_y, pbc_z) {
        const ptr0 = passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.jsmdstate_set_cell(this.__wbg_ptr, ptr0, len0, pbc_x, pbc_y, pbc_z);
    }
    /**
     * Set forces from flat array.
     *
     * # Panics
     * Panics if length doesn't match `n_atoms * 3`.
     * @param {Float64Array} forces
     */
    set forces(forces) {
        const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.jsmdstate_set_forces(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set positions from flat array.
     *
     * # Panics
     * Panics if length doesn't match `n_atoms * 3`.
     * @param {Float64Array} positions
     */
    set positions(positions) {
        const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.jsmdstate_set_positions(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set velocities from flat array.
     *
     * # Panics
     * Panics if length doesn't match `n_atoms * 3`.
     * @param {Float64Array} velocities
     */
    set velocities(velocities) {
        const ptr0 = passArrayF64ToWasm0(velocities, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.jsmdstate_set_velocities(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Compute temperature in Kelvin.
     * @returns {number}
     */
    temperature() {
        const ret = wasm.jsmdstate_temperature(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get velocities as flat array.
     * @returns {Float64Array}
     */
    get velocities() {
        const ret = wasm.jsmdstate_velocities(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) JsMDState.prototype[Symbol.dispose] = JsMDState.prototype.free;

/**
 * Streaming MSD calculator for large trajectories.
 *
 * Usage: create with new(), add frames with add_frame(), get result with compute_msd().
 */
export class JsMsdCalculator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsMsdCalculatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsmsdcalculator_free(ptr, 0);
    }
    /**
     * Add a frame to the MSD calculation.
     *
     * positions: flat array of [x0, y0, z0, x1, y1, z1, ...] for all atoms
     * @param {Float64Array} positions
     * @returns {WasmResult}
     */
    add_frame(positions) {
        const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.jsmsdcalculator_add_frame(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Compute final MSD values averaged over all atoms.
     *
     * Returns MSD values for each lag time (length = max_lag + 1).
     * @returns {Float64Array}
     */
    compute_msd() {
        const ret = wasm.jsmsdcalculator_compute_msd(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Compute MSD for each atom separately.
     *
     * Returns flattened array of shape (max_lag+1, n_atoms) in row-major order:
     * `[msd_lag0_atom0, msd_lag0_atom1, ..., msd_lag1_atom0, msd_lag1_atom1, ...]`
     *
     * To access MSD for atom `a` at lag `t`: `result[t * n_atoms + a]`
     * @returns {Float64Array}
     */
    compute_msd_per_atom() {
        const ret = wasm.jsmsdcalculator_compute_msd_per_atom(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get maximum lag time in frames.
     * @returns {number}
     */
    max_lag() {
        const ret = wasm.jsmsdcalculator_max_lag(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get number of atoms.
     * @returns {number}
     */
    n_atoms() {
        const ret = wasm.jsmsdcalculator_n_atoms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a new MSD calculator.
     *
     * n_atoms: number of atoms in each frame (must be > 0)
     * max_lag: maximum lag time in frames
     * origin_interval: frames between time origins (must be > 0, smaller = more samples)
     * @param {number} n_atoms
     * @param {number} max_lag
     * @param {number} origin_interval
     */
    constructor(n_atoms, max_lag, origin_interval) {
        const ret = wasm.jsmsdcalculator_new(n_atoms, max_lag, origin_interval);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsMsdCalculatorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) JsMsdCalculator.prototype[Symbol.dispose] = JsMsdCalculator.prototype.free;

/**
 * NPT integrator using Parrinello-Rahman barostat.
 */
export class JsNPTIntegrator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsNPTIntegratorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsnptintegrator_free(ptr, 0);
    }
    /**
     * Create a new NPT integrator.
     *
     * temperature: target temperature in Kelvin (must be non-negative)
     * pressure: target pressure in GPa
     * tau_t: thermostat time constant in femtoseconds (must be positive)
     * tau_p: barostat time constant in femtoseconds (must be positive)
     * dt: timestep in femtoseconds (must be positive)
     * n_atoms: number of atoms
     * total_mass: total system mass in amu (must be positive)
     * @param {number} temperature
     * @param {number} pressure
     * @param {number} tau_t
     * @param {number} tau_p
     * @param {number} dt
     * @param {number} n_atoms
     * @param {number} total_mass
     */
    constructor(temperature, pressure, tau_t, tau_p, dt, n_atoms, total_mass) {
        const ret = wasm.jsnptintegrator_new(temperature, pressure, tau_t, tau_p, dt, n_atoms, total_mass);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsNPTIntegratorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get instantaneous pressure from stress tensor.
     * @param {Float64Array} stress
     * @returns {WasmResult}
     */
    pressure(stress) {
        const ptr0 = passArrayF64ToWasm0(stress, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.jsnptintegrator_pressure(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) JsNPTIntegrator.prototype[Symbol.dispose] = JsNPTIntegrator.prototype.free;

/**
 * State for NPT molecular dynamics with variable cell.
 */
export class JsNPTState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsNPTStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsnptstate_free(ptr, 0);
    }
    /**
     * Get cell matrix as flat array.
     * @returns {Float64Array}
     */
    get cell() {
        const ret = wasm.jsnptstate_cell(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get kinetic energy in eV.
     * @returns {number}
     */
    kinetic_energy() {
        const ret = wasm.jsnptstate_kinetic_energy(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create a new NPT state.
     *
     * positions: flat array [x0, y0, z0, ...] in Angstrom
     * masses: array of atomic masses in amu
     * cell: 9-element cell matrix (row-major) in Angstrom
     * pbc_x, pbc_y, pbc_z: periodic boundary conditions
     * @param {Float64Array} positions
     * @param {Float64Array} masses
     * @param {Float64Array} cell
     * @param {boolean} pbc_x
     * @param {boolean} pbc_y
     * @param {boolean} pbc_z
     */
    constructor(positions, masses, cell, pbc_x, pbc_y, pbc_z) {
        const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(masses, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.jsnptstate_new(ptr0, len0, ptr1, len1, ptr2, len2, pbc_x, pbc_y, pbc_z);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsNPTStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Number of atoms.
     * @returns {number}
     */
    get num_atoms() {
        const ret = wasm.jsnptstate_num_atoms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get positions as flat array.
     * @returns {Float64Array}
     */
    get positions() {
        const ret = wasm.jsnptstate_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get temperature in Kelvin.
     * @returns {number}
     */
    temperature() {
        const ret = wasm.jsnptstate_temperature(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get velocities as flat array.
     * @returns {Float64Array}
     */
    get velocities() {
        const ret = wasm.jsnptstate_velocities(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get cell volume in Angstrom³.
     * @returns {number}
     */
    volume() {
        const ret = wasm.jsnptstate_volume(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) JsNPTState.prototype[Symbol.dispose] = JsNPTState.prototype.free;

/**
 * Nose-Hoover chain thermostat for NVT ensemble.
 */
export class JsNoseHooverChain {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsNoseHooverChainFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsnosehooverchain_free(ptr, 0);
    }
    /**
     * Create a new Nose-Hoover chain thermostat.
     *
     * target_temp: target temperature in Kelvin (must be non-negative)
     * tau: coupling time constant in femtoseconds (must be positive)
     * dt: timestep in femtoseconds (must be positive)
     * n_dof: number of degrees of freedom (typically 3 * n_atoms - 3)
     * @param {number} target_temp
     * @param {number} tau
     * @param {number} dt
     * @param {number} n_dof
     */
    constructor(target_temp, tau, dt, n_dof) {
        const ret = wasm.jsnosehooverchain_new(target_temp, tau, dt, n_dof);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsNoseHooverChainFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set target temperature.
     * @param {number} target_temp
     */
    set_temperature(target_temp) {
        wasm.jsnosehooverchain_set_temperature(this.__wbg_ptr, target_temp);
    }
}
if (Symbol.dispose) JsNoseHooverChain.prototype[Symbol.dispose] = JsNoseHooverChain.prototype.free;

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
    get atomic_number() {
        const ret = wasm.jsspecies_atomic_number(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get atomic radius (or NaN if not defined).
     * @returns {number}
     */
    get atomic_radius() {
        const ret = wasm.jsspecies_atomic_radius(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get covalent radius (or NaN if not defined).
     * @returns {number}
     */
    get covalent_radius() {
        const ret = wasm.jsspecies_covalent_radius(this.__wbg_ptr);
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
    get ionic_radius() {
        const ret = wasm.jsspecies_ionic_radius(this.__wbg_ptr);
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
    get oxidation_state() {
        const ret = wasm.jsspecies_oxidation_state(this.__wbg_ptr);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * Get Shannon ionic radius with coordination and spin (or NaN if not defined).
     * @param {string} coordination
     * @param {string} spin
     * @returns {number}
     */
    shannon_ionic_radius(coordination, spin) {
        const ptr0 = passStringToWasm0(coordination, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(spin, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.jsspecies_shannon_ionic_radius(this.__wbg_ptr, ptr0, len0, ptr1, len1);
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
    to_string() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.jsspecies_to_string(this.__wbg_ptr);
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
 * Streaming VACF calculator for large trajectories.
 */
export class JsVacfCalculator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsVacfCalculatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsvacfcalculator_free(ptr, 0);
    }
    /**
     * Add a frame to the VACF calculation.
     *
     * velocities: flat array of [vx0, vy0, vz0, vx1, vy1, vz1, ...] for all atoms
     * @param {Float64Array} velocities
     * @returns {WasmResult}
     */
    add_frame(velocities) {
        const ptr0 = passArrayF64ToWasm0(velocities, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.jsvacfcalculator_add_frame(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Compute normalized VACF (VACF(t) / VACF(0)).
     * @returns {Float64Array}
     */
    compute_normalized_vacf() {
        const ret = wasm.jsvacfcalculator_compute_normalized_vacf(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Compute final VACF values.
     * @returns {Float64Array}
     */
    compute_vacf() {
        const ret = wasm.jsvacfcalculator_compute_vacf(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get maximum lag time in frames.
     * @returns {number}
     */
    max_lag() {
        const ret = wasm.jsmsdcalculator_max_lag(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get number of atoms.
     * @returns {number}
     */
    n_atoms() {
        const ret = wasm.jsmsdcalculator_n_atoms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Create a new VACF calculator.
     *
     * n_atoms: number of atoms in each frame (must be > 0)
     * max_lag: maximum lag time in frames
     * origin_interval: frames between time origins (must be > 0, smaller = more samples)
     * @param {number} n_atoms
     * @param {number} max_lag
     * @param {number} origin_interval
     */
    constructor(n_atoms, max_lag, origin_interval) {
        const ret = wasm.jsvacfcalculator_new(n_atoms, max_lag, origin_interval);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsVacfCalculatorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) JsVacfCalculator.prototype[Symbol.dispose] = JsVacfCalculator.prototype.free;

/**
 * Velocity rescaling thermostat (stochastic, canonical sampling).
 */
export class JsVelocityRescale {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsVelocityRescaleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsvelocityrescale_free(ptr, 0);
    }
    /**
     * Create a new velocity rescale thermostat.
     *
     * target_temp: target temperature in Kelvin (must be non-negative)
     * tau: coupling time constant in femtoseconds (must be positive)
     * dt: timestep in femtoseconds (must be positive)
     * n_dof: number of degrees of freedom
     * seed: optional RNG seed
     * @param {number} target_temp
     * @param {number} tau
     * @param {number} dt
     * @param {number} n_dof
     * @param {bigint | null} [seed]
     */
    constructor(target_temp, tau, dt, n_dof, seed) {
        const ret = wasm.jsvelocityrescale_new(target_temp, tau, dt, n_dof, !isLikeNone(seed), isLikeNone(seed) ? BigInt(0) : seed);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        JsVelocityRescaleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set target temperature.
     * @param {number} target_temp
     */
    set_temperature(target_temp) {
        wasm.jsvelocityrescale_set_temperature(this.__wbg_ptr, target_temp);
    }
}
if (Symbol.dispose) JsVelocityRescale.prototype[Symbol.dispose] = JsVelocityRescale.prototype.free;

/**
 * JavaScript-accessible StructureMatcher wrapper with builder pattern.
 */
export class WasmStructureMatcher {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(WasmStructureMatcher.prototype);
        obj.__wbg_ptr = ptr;
        WasmStructureMatcherFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmStructureMatcherFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmstructurematcher_free(ptr, 0);
    }
    /**
     * Deduplicate a list of structures.
     * Returns array where result[i] is the index of the first matching structure.
     * @param {JsCrystal[]} structures
     * @returns {WasmResult}
     */
    deduplicate(structures) {
        const ptr0 = passArrayJsValueToWasm0(structures, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmstructurematcher_deduplicate(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Find matches for new structures against existing structures.
     * Returns array where result[i] is the index of matching existing structure or null.
     * @param {JsCrystal[]} new_structures
     * @param {JsCrystal[]} existing_structures
     * @returns {WasmResult}
     */
    find_matches(new_structures, existing_structures) {
        const ptr0 = passArrayJsValueToWasm0(new_structures, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayJsValueToWasm0(existing_structures, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.wasmstructurematcher_find_matches(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret;
    }
    /**
     * Check if two structures match.
     * @param {JsCrystal} struct1
     * @param {JsCrystal} struct2
     * @returns {WasmResult}
     */
    fit(struct1, struct2) {
        const ret = wasm.wasmstructurematcher_fit(this.__wbg_ptr, struct1, struct2);
        return ret;
    }
    /**
     * Check if two structures match under any species permutation.
     * @param {JsCrystal} struct1
     * @param {JsCrystal} struct2
     * @returns {WasmResult}
     */
    fit_anonymous(struct1, struct2) {
        const ret = wasm.wasmstructurematcher_fit_anonymous(this.__wbg_ptr, struct1, struct2);
        return ret;
    }
    /**
     * Get RMS distance between two structures.
     * @param {JsCrystal} struct1
     * @param {JsCrystal} struct2
     * @returns {WasmResult}
     */
    get_rms_dist(struct1, struct2) {
        const ret = wasm.wasmstructurematcher_get_rms_dist(this.__wbg_ptr, struct1, struct2);
        return ret;
    }
    /**
     * Compute a universal distance between any two structures.
     *
     * Unlike `get_rms_dist` which may return null for incompatible structures,
     * this method always returns a finite distance value, making it suitable for
     * consistent ranking of structures by similarity and compatible with `Number.isFinite()`.
     *
     * # Properties
     * - d(x, y) ≥ 0 (non-negative)
     * - d(x, x) = 0 (identity)
     * - d(x, y) = d(y, x) (symmetric)
     * - Always finite (clamped to 1e9 if underlying computation yields non-finite)
     *
     * Note: Triangle inequality is not guaranteed due to greedy matching.
     *
     * # Returns
     * Finite distance in [0, 1e9]. Smaller values indicate more similar structures.
     * @param {JsCrystal} struct1
     * @param {JsCrystal} struct2
     * @returns {WasmResult}
     */
    get_structure_distance(struct1, struct2) {
        const ret = wasm.wasmstructurematcher_get_structure_distance(this.__wbg_ptr, struct1, struct2);
        return ret;
    }
    /**
     * Create a new StructureMatcher with default settings.
     */
    constructor() {
        const ret = wasm.wasmstructurematcher_new();
        this.__wbg_ptr = ret >>> 0;
        WasmStructureMatcherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set the angle tolerance (degrees).
     * @param {number} tol
     * @returns {WasmStructureMatcher}
     */
    with_angle_tol(tol) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmstructurematcher_with_angle_tol(ptr, tol);
        return WasmStructureMatcher.__wrap(ret);
    }
    /**
     * Set whether to use element-only comparison (ignores oxidation states).
     * @param {boolean} val
     * @returns {WasmStructureMatcher}
     */
    with_element_comparator(val) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmstructurematcher_with_element_comparator(ptr, val);
        return WasmStructureMatcher.__wrap(ret);
    }
    /**
     * Set the lattice length tolerance (fractional).
     * @param {number} tol
     * @returns {WasmStructureMatcher}
     */
    with_latt_len_tol(tol) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmstructurematcher_with_latt_len_tol(ptr, tol);
        return WasmStructureMatcher.__wrap(ret);
    }
    /**
     * Set whether to reduce to primitive cell before matching.
     * @param {boolean} val
     * @returns {WasmStructureMatcher}
     */
    with_primitive_cell(val) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmstructurematcher_with_primitive_cell(ptr, val);
        return WasmStructureMatcher.__wrap(ret);
    }
    /**
     * Set whether to scale volumes to match.
     * @param {boolean} val
     * @returns {WasmStructureMatcher}
     */
    with_scale(val) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmstructurematcher_with_scale(ptr, val);
        return WasmStructureMatcher.__wrap(ret);
    }
    /**
     * Set the site position tolerance (normalized).
     * @param {number} tol
     * @returns {WasmStructureMatcher}
     */
    with_site_pos_tol(tol) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmstructurematcher_with_site_pos_tol(ptr, tol);
        return WasmStructureMatcher.__wrap(ret);
    }
}
if (Symbol.dispose) WasmStructureMatcher.prototype[Symbol.dispose] = WasmStructureMatcher.prototype.free;

/**
 * Apply inversion symmetry to the structure.
 * @param {JsCrystal} structure
 * @param {boolean} fractional
 * @returns {WasmResult}
 */
export function apply_inversion(structure, fractional) {
    const ret = wasm.apply_inversion(structure, fractional);
    return ret;
}

/**
 * Apply a symmetry operation to the structure.
 * The rotation matrix should be a 3x3 float matrix, and translation is a 3D vector.
 * If fractional is true, the operation is applied in fractional coordinates.
 * @param {JsCrystal} structure
 * @param {JsMatrix3x3} rotation
 * @param {JsVector3} translation
 * @param {boolean} fractional
 * @returns {WasmResult}
 */
export function apply_operation(structure, rotation, translation, fractional) {
    const ret = wasm.apply_operation(structure, rotation, translation, fractional);
    return ret;
}

/**
 * Convert an ASE Atoms dict to pymatgen format.
 *
 * Returns JSON string for either a Structure or Molecule depending on periodicity.
 * @param {JsAseAtoms} ase_atoms
 * @returns {WasmResult}
 */
export function ase_to_pymatgen(ase_atoms) {
    const ret = wasm.ase_to_pymatgen(ase_atoms);
    return ret;
}

/**
 * Perform Delaunay reduction on a lattice.
 *
 * Returns JSON object with reduced lattice matrix and transformation matrix.
 * @param {JsCrystal} structure
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function cell_delaunay_reduce(structure, tolerance) {
    const ret = wasm.cell_delaunay_reduce(structure, tolerance);
    return ret;
}

/**
 * Find supercell transformation matrix for target atom count.
 *
 * Returns JSON array [[a1,a2,a3],[b1,b2,b3],[c1,c2,c3]].
 * @param {JsCrystal} structure
 * @param {number} target_atoms
 * @returns {WasmResult}
 */
export function cell_find_supercell_matrix(structure, target_atoms) {
    const ret = wasm.cell_find_supercell_matrix(structure, target_atoms);
    return ret;
}

/**
 * Perform one CellFIRE optimization step with provided forces and stress.
 * @param {JsCellFireState} state
 * @param {Float64Array} forces
 * @param {Float64Array} stress
 * @returns {WasmResult}
 */
export function cell_fire_step_with_forces_and_stress(state, forces, stress) {
    _assertClass(state, JsCellFireState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(stress, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cell_fire_step_with_forces_and_stress(state.__wbg_ptr, ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Check if a lattice is already Niggli-reduced.
 * @param {JsCrystal} structure
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function cell_is_niggli_reduced(structure, tolerance) {
    const ret = wasm.cell_is_niggli_reduced(structure, tolerance);
    return ret;
}

/**
 * Check if one lattice is a supercell of another.
 *
 * Returns JSON: null if not a supercell, or [[a,b,c],[d,e,f],[g,h,i]] transformation.
 * @param {JsCrystal} structure
 * @param {JsCrystal} other
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function cell_is_supercell(structure, other, tolerance) {
    const ret = wasm.cell_is_supercell(structure, other, tolerance);
    return ret;
}

/**
 * Check if two lattices are equivalent under rotation/permutation.
 * @param {JsCrystal} structure1
 * @param {JsCrystal} structure2
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function cell_lattices_equivalent(structure1, structure2, tolerance) {
    const ret = wasm.cell_lattices_equivalent(structure1, structure2, tolerance);
    return ret;
}

/**
 * Calculate minimum image distance between two fractional positions.
 * @param {JsCrystal} structure
 * @param {Float64Array} frac1
 * @param {Float64Array} frac2
 * @returns {WasmResult}
 */
export function cell_minimum_image_distance(structure, frac1, frac2) {
    const ptr0 = passArrayF64ToWasm0(frac1, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(frac2, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cell_minimum_image_distance(structure, ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Calculate minimum image vector between two fractional positions.
 *
 * Returns JSON array [x, y, z] of the Cartesian displacement.
 * @param {JsCrystal} structure
 * @param {Float64Array} frac1
 * @param {Float64Array} frac2
 * @returns {WasmResult}
 */
export function cell_minimum_image_vector(structure, frac1, frac2) {
    const ptr0 = passArrayF64ToWasm0(frac1, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(frac2, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.cell_minimum_image_vector(structure, ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Perform Niggli reduction on a lattice.
 *
 * Returns JSON object with reduced lattice matrix and transformation matrix.
 * @param {JsCrystal} structure
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function cell_niggli_reduce(structure, tolerance) {
    const ret = wasm.cell_niggli_reduce(structure, tolerance);
    return ret;
}

/**
 * Get perpendicular distances for each lattice axis.
 *
 * Returns JSON array [d_a, d_b, d_c].
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function cell_perpendicular_distances(structure) {
    const ret = wasm.cell_perpendicular_distances(structure);
    return ret;
}

/**
 * Wrap all site positions to the unit cell [0, 1)^3.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function cell_wrap_to_unit_cell(structure) {
    const ret = wasm.cell_wrap_to_unit_cell(structure);
    return ret;
}

/**
 * Classify all atoms in a structure based on their local order parameters.
 *
 * Returns structure type string for each atom.
 * @param {JsCrystal} structure
 * @param {number} cutoff
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function classify_all_atoms(structure, cutoff, tolerance) {
    const ret = wasm.classify_all_atoms(structure, cutoff, tolerance);
    return ret;
}

/**
 * Classify local structure based on q4 and q6 values.
 *
 * Returns structure type: "fcc", "bcc", "hcp", "icosahedral", "liquid", or "unknown".
 * @param {number} q4
 * @param {number} q6
 * @param {number} tolerance
 * @returns {string}
 */
export function classify_local_structure(q4, q6, tolerance) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.classify_local_structure(q4, q6, tolerance);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Get the net charge of a composition.
 *
 * Returns null if any species lacks an oxidation state, or if the charge is non-integer.
 * @param {string} formula
 * @returns {WasmResult}
 */
export function composition_charge(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.composition_charge(ptr0, len0);
    return ret;
}

/**
 * Check if two compositions are approximately equal.
 *
 * Uses relative tolerance of 0.01 (1%) and absolute tolerance of 1e-8.
 * @param {string} formula1
 * @param {string} formula2
 * @returns {WasmResult}
 */
export function compositions_almost_equal(formula1, formula2) {
    const ptr0 = passStringToWasm0(formula1, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(formula2, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.compositions_almost_equal(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Compute d-spacing for a Miller index using local slab.rs implementation.
 * @param {string} structure_json
 * @param {number} h
 * @param {number} k
 * @param {number} l
 * @returns {number}
 */
export function compute_d_spacing(structure_json, h, k, l) {
    const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.compute_d_spacing(ptr0, len0, h, k, l);
    return ret;
}

/**
 * Compute harmonic bond energy and forces.
 *
 * V = 0.5 * k * (r - r₀)²
 *
 * positions: flat array [x0, y0, z0, x1, y1, z1, ...] in Angstrom
 * bonds: flat array [i0, j0, k0, r0_0, i1, j1, k1, r0_1, ...] where
 *        i,j are atom indices, k is spring constant (eV/Å²), r0 is equilibrium distance (Å)
 * cell: optional 3x3 cell matrix as flat array
 * pbc_x, pbc_y, pbc_z: periodic boundary conditions
 * compute_stress: whether to compute stress tensor
 * @param {Float64Array} positions
 * @param {Float64Array} bonds
 * @param {Float64Array | null | undefined} cell
 * @param {boolean} pbc_x
 * @param {boolean} pbc_y
 * @param {boolean} pbc_z
 * @param {boolean} compute_stress
 * @returns {WasmResult}
 */
export function compute_harmonic_bonds(positions, bonds, cell, pbc_x, pbc_y, pbc_z, compute_stress) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(bonds, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(cell) ? 0 : passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
    var len2 = WASM_VECTOR_LEN;
    const ret = wasm.compute_harmonic_bonds(ptr0, len0, ptr1, len1, ptr2, len2, pbc_x, pbc_y, pbc_z, compute_stress);
    return ret;
}

/**
 * Compute Lennard-Jones potential energy and forces.
 *
 * V(r) = 4ε[(σ/r)¹² - (σ/r)⁶]
 *
 * positions: flat array [x0, y0, z0, x1, y1, z1, ...] in Angstrom
 * cell: optional 3x3 cell matrix as flat array [a1, a2, a3, b1, b2, b3, c1, c2, c3]
 * pbc_x, pbc_y, pbc_z: periodic boundary conditions
 * sigma: LJ sigma in Angstrom (default: 3.4 for Ar)
 * epsilon: LJ epsilon in eV (default: 0.0103 for Ar)
 * cutoff: optional cutoff distance in Angstrom
 * compute_stress: whether to compute stress tensor
 * @param {Float64Array} positions
 * @param {Float64Array | null | undefined} cell
 * @param {boolean} pbc_x
 * @param {boolean} pbc_y
 * @param {boolean} pbc_z
 * @param {number} sigma
 * @param {number} epsilon
 * @param {number | null | undefined} cutoff
 * @param {boolean} compute_stress
 * @returns {WasmResult}
 */
export function compute_lennard_jones(positions, cell, pbc_x, pbc_y, pbc_z, sigma, epsilon, cutoff, compute_stress) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(cell) ? 0 : passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.compute_lennard_jones(ptr0, len0, ptr1, len1, pbc_x, pbc_y, pbc_z, sigma, epsilon, !isLikeNone(cutoff), isLikeNone(cutoff) ? 0 : cutoff, compute_stress);
    return ret;
}

/**
 * Compute Lennard-Jones forces only.
 *
 * Returns flat array of forces [Fx0, Fy0, Fz0, Fx1, Fy1, Fz1, ...] in eV/Å.
 * @param {Float64Array} positions
 * @param {Float64Array | null | undefined} cell
 * @param {boolean} pbc_x
 * @param {boolean} pbc_y
 * @param {boolean} pbc_z
 * @param {number} sigma
 * @param {number} epsilon
 * @param {number | null} [cutoff]
 * @returns {WasmResult}
 */
export function compute_lennard_jones_forces(positions, cell, pbc_x, pbc_y, pbc_z, sigma, epsilon, cutoff) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(cell) ? 0 : passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.compute_lennard_jones_forces(ptr0, len0, ptr1, len1, pbc_x, pbc_y, pbc_z, sigma, epsilon, !isLikeNone(cutoff), isLikeNone(cutoff) ? 0 : cutoff);
    return ret;
}

/**
 * Compute Morse potential energy and forces.
 *
 * V(r) = D * (1 - exp(-α(r - r₀)))² - D
 *
 * positions: flat array [x0, y0, z0, x1, y1, z1, ...] in Angstrom
 * cell: optional 3x3 cell matrix as flat array
 * pbc_x, pbc_y, pbc_z: periodic boundary conditions
 * d: well depth in eV
 * alpha: width parameter in 1/Angstrom
 * r0: equilibrium distance in Angstrom
 * cutoff: cutoff distance in Angstrom
 * compute_stress: whether to compute stress tensor
 * @param {Float64Array} positions
 * @param {Float64Array | null | undefined} cell
 * @param {boolean} pbc_x
 * @param {boolean} pbc_y
 * @param {boolean} pbc_z
 * @param {number} d
 * @param {number} alpha
 * @param {number} r0
 * @param {number} cutoff
 * @param {boolean} compute_stress
 * @returns {WasmResult}
 */
export function compute_morse(positions, cell, pbc_x, pbc_y, pbc_z, d, alpha, r0, cutoff, compute_stress) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(cell) ? 0 : passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.compute_morse(ptr0, len0, ptr1, len1, pbc_x, pbc_y, pbc_z, d, alpha, r0, cutoff, compute_stress);
    return ret;
}

/**
 * Compute soft sphere potential energy and forces.
 *
 * V(r) = ε(σ/r)^α
 *
 * positions: flat array [x0, y0, z0, x1, y1, z1, ...] in Angstrom
 * cell: optional 3x3 cell matrix as flat array
 * pbc_x, pbc_y, pbc_z: periodic boundary conditions
 * sigma: length scale in Angstrom
 * epsilon: energy scale in eV
 * alpha: exponent (default 12, use 2 for soft spheres)
 * cutoff: cutoff distance in Angstrom
 * compute_stress: whether to compute stress tensor
 * @param {Float64Array} positions
 * @param {Float64Array | null | undefined} cell
 * @param {boolean} pbc_x
 * @param {boolean} pbc_y
 * @param {boolean} pbc_z
 * @param {number} sigma
 * @param {number} epsilon
 * @param {number} alpha
 * @param {number} cutoff
 * @param {boolean} compute_stress
 * @returns {WasmResult}
 */
export function compute_soft_sphere(positions, cell, pbc_x, pbc_y, pbc_z, sigma, epsilon, alpha, cutoff, compute_stress) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(cell) ? 0 : passArrayF64ToWasm0(cell, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.compute_soft_sphere(ptr0, len0, ptr1, len1, pbc_x, pbc_y, pbc_z, sigma, epsilon, alpha, cutoff, compute_stress);
    return ret;
}

/**
 * Compute Steinhardt q_l order parameter for each atom.
 *
 * l is typically 4 or 6. cutoff is the neighbor distance in Angstrom.
 * Returns q_l values for each atom.
 * @param {JsCrystal} structure
 * @param {number} degree
 * @param {number} cutoff
 * @returns {WasmResult}
 */
export function compute_steinhardt_q(structure, degree, cutoff) {
    const ret = wasm.compute_steinhardt_q(structure, degree, cutoff);
    return ret;
}

/**
 * Compute powder X-ray diffraction pattern from a structure.
 *
 * Options:
 * - wavelength: X-ray wavelength in Angstroms (default: 1.54184, Cu Kα)
 * - two_theta_range: [min, max] 2θ angles in degrees (default: [0, 180])
 * - debye_waller_factors: Element symbol -> B factor mapping
 * - scaled: Whether to scale intensities to 0-100 (default: true)
 * @param {JsCrystal} structure
 * @param {JsXrdOptions | null} [options]
 * @returns {WasmResult}
 */
export function compute_xrd(structure, options) {
    const ret = wasm.compute_xrd(structure, isLikeNone(options) ? 0 : addToExternrefTable0(options));
    return ret;
}

/**
 * Create a copy of the structure, optionally sanitized.
 * @param {JsCrystal} structure
 * @param {boolean} sanitize
 * @returns {WasmResult}
 */
export function copy_structure(structure, sanitize) {
    const ret = wasm.copy_structure(structure, sanitize);
    return ret;
}

/**
 * Classify an interstitial site based on its coordination number.
 * @param {number} coordination
 * @returns {string}
 */
export function defect_classify_site(coordination) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.defect_classify_site(coordination);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Create an antisite pair by swapping species at two sites.
 * @param {JsCrystal} structure
 * @param {number} site_a_idx
 * @param {number} site_b_idx
 * @returns {WasmResult}
 */
export function defect_create_antisite(structure, site_a_idx, site_b_idx) {
    const ret = wasm.defect_create_antisite(structure, site_a_idx, site_b_idx);
    return ret;
}

/**
 * Create a dimer by moving two atoms closer together.
 * @param {JsCrystal} structure
 * @param {number} site_a_idx
 * @param {number} site_b_idx
 * @param {number} target_distance
 * @returns {WasmResult}
 */
export function defect_create_dimer(structure, site_a_idx, site_b_idx, target_distance) {
    const ret = wasm.defect_create_dimer(structure, site_a_idx, site_b_idx, target_distance);
    return ret;
}

/**
 * Create an interstitial by adding an atom at a fractional position.
 * @param {JsCrystal} structure
 * @param {Float64Array} position
 * @param {string} species
 * @returns {WasmResult}
 */
export function defect_create_interstitial(structure, position, species) {
    const ptr0 = passArrayF64ToWasm0(position, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.defect_create_interstitial(structure, ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Create a substitutional defect by replacing the species at a site.
 * @param {JsCrystal} structure
 * @param {number} site_idx
 * @param {string} new_species
 * @returns {WasmResult}
 */
export function defect_create_substitution(structure, site_idx, new_species) {
    const ptr0 = passStringToWasm0(new_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.defect_create_substitution(structure, site_idx, ptr0, len0);
    return ret;
}

/**
 * Create a vacancy by removing an atom at the specified site index.
 *
 * Returns JSON with 'structure' (defective structure) and defect info.
 * @param {JsCrystal} structure
 * @param {number} site_idx
 * @returns {WasmResult}
 */
export function defect_create_vacancy(structure, site_idx) {
    const ret = wasm.defect_create_vacancy(structure, site_idx);
    return ret;
}

/**
 * Distort bonds around a defect site by specified factors.
 *
 * Returns JSON array of distorted structures with metadata.
 * @param {JsCrystal} structure
 * @param {number} center_site_idx
 * @param {Float64Array} distortion_factors
 * @param {number | null | undefined} num_neighbors
 * @param {number} cutoff
 * @returns {WasmResult}
 */
export function defect_distort_bonds(structure, center_site_idx, distortion_factors, num_neighbors, cutoff) {
    const ptr0 = passArrayF64ToWasm0(distortion_factors, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.defect_distort_bonds(structure, center_site_idx, ptr0, len0, isLikeNone(num_neighbors) ? 0x100000001 : (num_neighbors) >>> 0, cutoff);
    return ret;
}

/**
 * Find potential interstitial sites using Voronoi tessellation.
 *
 * Returns JSON array of sites with frac_coords, cart_coords, min_distance, coordination, site_type.
 * @param {JsCrystal} structure
 * @param {number} min_dist
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function defect_find_interstitial_sites(structure, min_dist, symprec) {
    const ret = wasm.defect_find_interstitial_sites(structure, min_dist, symprec);
    return ret;
}

/**
 * Find an optimal supercell matrix for dilute defect calculations.
 *
 * Returns flat array of 9 integers [a1,a2,a3, b1,b2,b3, c1,c2,c3].
 * @param {JsCrystal} structure
 * @param {number} min_image_dist
 * @param {number} max_atoms
 * @param {number} cubic_preference
 * @returns {WasmResult}
 */
export function defect_find_supercell(structure, min_image_dist, max_atoms, cubic_preference) {
    const ret = wasm.defect_find_supercell(structure, min_image_dist, max_atoms, cubic_preference);
    return ret;
}

/**
 * Generate all point defects for a structure.
 *
 * Returns JSON object with supercell_matrix, vacancies, substitutions,
 * interstitials, antisites, spacegroup, n_defects.
 * @param {JsCrystal} structure
 * @param {string} extrinsic_json
 * @param {boolean} include_vacancies
 * @param {boolean} include_substitutions
 * @param {boolean} include_interstitials
 * @param {boolean} include_antisites
 * @param {number} supercell_min_dist
 * @param {number} supercell_max_atoms
 * @param {number | null | undefined} interstitial_min_dist
 * @param {number} symprec
 * @param {number} max_charge
 * @returns {WasmResult}
 */
export function defect_generate_all(structure, extrinsic_json, include_vacancies, include_substitutions, include_interstitials, include_antisites, supercell_min_dist, supercell_max_atoms, interstitial_min_dist, symprec, max_charge) {
    const ptr0 = passStringToWasm0(extrinsic_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.defect_generate_all(structure, ptr0, len0, include_vacancies, include_substitutions, include_interstitials, include_antisites, supercell_min_dist, supercell_max_atoms, !isLikeNone(interstitial_min_dist), isLikeNone(interstitial_min_dist) ? 0 : interstitial_min_dist, symprec, max_charge);
    return ret;
}

/**
 * Generate a doped-compatible name for a point defect.
 * @param {string} defect_type
 * @param {string | null} [species]
 * @param {string | null} [original_species]
 * @param {string | null} [wyckoff]
 * @param {string | null} [site_type]
 * @returns {WasmResult}
 */
export function defect_generate_name(defect_type, species, original_species, wyckoff, site_type) {
    const ptr0 = passStringToWasm0(defect_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(species) ? 0 : passStringToWasm0(species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(original_species) ? 0 : passStringToWasm0(original_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(wyckoff) ? 0 : passStringToWasm0(wyckoff, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len3 = WASM_VECTOR_LEN;
    var ptr4 = isLikeNone(site_type) ? 0 : passStringToWasm0(site_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len4 = WASM_VECTOR_LEN;
    const ret = wasm.defect_generate_name(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    return ret;
}

/**
 * Get Wyckoff labels for all sites in a structure.
 *
 * Returns JSON array of {label, multiplicity, site_symmetry} objects.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function defect_get_wyckoff_labels(structure, symprec) {
    const ret = wasm.defect_get_wyckoff_labels(structure, symprec);
    return ret;
}

/**
 * Guess likely charge states for a point defect based on oxidation state probabilities.
 *
 * Returns JSON array of {charge, probability, reasoning} objects.
 * @param {string} defect_type
 * @param {string | null | undefined} removed_species
 * @param {string | null | undefined} added_species
 * @param {string | null | undefined} original_species
 * @param {number} max_charge
 * @returns {WasmResult}
 */
export function defect_guess_charge_states(defect_type, removed_species, added_species, original_species, max_charge) {
    const ptr0 = passStringToWasm0(defect_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(removed_species) ? 0 : passStringToWasm0(removed_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = isLikeNone(added_species) ? 0 : passStringToWasm0(added_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(original_species) ? 0 : passStringToWasm0(original_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len3 = WASM_VECTOR_LEN;
    const ret = wasm.defect_guess_charge_states(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, max_charge);
    return ret;
}

/**
 * Apply local rattling with distance-dependent amplitude decay.
 * @param {JsCrystal} structure
 * @param {number} center_site_idx
 * @param {number} max_amplitude
 * @param {number} decay_radius
 * @param {number} seed
 * @returns {WasmResult}
 */
export function defect_local_rattle(structure, center_site_idx, max_amplitude, decay_radius, seed) {
    const ret = wasm.defect_local_rattle(structure, center_site_idx, max_amplitude, decay_radius, seed);
    return ret;
}

/**
 * Apply Monte Carlo rattling - random displacements to all atoms.
 * @param {JsCrystal} structure
 * @param {number} stdev
 * @param {number} seed
 * @param {number} min_distance
 * @param {number} max_attempts
 * @returns {WasmResult}
 */
export function defect_rattle(structure, stdev, seed, min_distance, max_attempts) {
    const ret = wasm.defect_rattle(structure, stdev, seed, min_distance, max_attempts);
    return ret;
}

/**
 * Detect atomic layers along a normal direction.
 * @param {string} structure_json
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @returns {string}
 */
export function detect_layers(structure_json, nx, ny, nz) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.detect_layers(ptr0, len0, nx, ny, nz);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Detect atomic layers along a Miller index direction.
 * @param {string} structure_json
 * @param {number} h
 * @param {number} k
 * @param {number} l
 * @returns {string}
 */
export function detect_layers_miller(structure_json, h, k, l) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.detect_layers_miller(ptr0, len0, h, k, l);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Compute diffusion coefficient from MSD using Einstein relation.
 *
 * D = MSD / (2 * dim * t) fitted in the linear regime.
 *
 * Returns array of length 2: `[diffusion_coefficient, r_squared]`
 * where r_squared indicates fit quality (1.0 = perfect linear fit).
 * @param {Float64Array} msd
 * @param {Float64Array} times
 * @param {number} dim
 * @param {number} start_fraction
 * @param {number} end_fraction
 * @returns {WasmResult}
 */
export function diffusion_from_msd(msd, times, dim, start_fraction, end_fraction) {
    const ptr0 = passArrayF64ToWasm0(msd, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(times, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.diffusion_from_msd(ptr0, len0, ptr1, len1, dim, start_fraction, end_fraction);
    return ret;
}

/**
 * Compute diffusion coefficient from VACF using Green-Kubo relation.
 *
 * D = (1/dim) * integral_0^inf VACF(t) dt
 * @param {Float64Array} vacf
 * @param {number} dt
 * @param {number} dim
 * @returns {WasmResult}
 */
export function diffusion_from_vacf(vacf, dt, dim) {
    const ptr0 = passArrayF64ToWasm0(vacf, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.diffusion_from_vacf(ptr0, len0, dt, dim);
    return ret;
}

/**
 * Apply strain to a cell matrix.
 *
 * Returns the deformed cell: cell_new = cell * (I + strain)
 * @param {JsMatrix3x3} cell
 * @param {JsMatrix3x3} strain
 * @returns {JsMatrix3x3}
 */
export function elastic_apply_strain(cell, strain) {
    const ret = wasm.elastic_apply_strain(cell, strain);
    return ret;
}

/**
 * Compute Voigt-Reuss-Hill bulk modulus from 6x6 elastic tensor.
 *
 * tensor: flat array of 36 elements in row-major order
 * @param {Float64Array} tensor
 * @returns {WasmResult}
 */
export function elastic_bulk_modulus(tensor) {
    const ptr0 = passArrayF64ToWasm0(tensor, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.elastic_bulk_modulus(ptr0, len0);
    return ret;
}

/**
 * Generate strain matrices for elastic tensor calculation.
 *
 * Returns 6 or 12 strain matrices depending on whether shear strains are included.
 * Each strain type is applied in both positive and negative directions.
 * @param {number} magnitude
 * @param {boolean} shear
 * @returns {WasmResult}
 */
export function elastic_generate_strains(magnitude, shear) {
    const ret = wasm.elastic_generate_strains(magnitude, shear);
    return ret;
}

/**
 * Check if elastic tensor satisfies mechanical stability (positive definite).
 *
 * tensor: flat array of 36 elements in row-major order
 * @param {Float64Array} tensor
 * @returns {WasmResult}
 */
export function elastic_is_stable(tensor) {
    const ptr0 = passArrayF64ToWasm0(tensor, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.elastic_is_stable(ptr0, len0);
    return ret;
}

/**
 * Compute Poisson's ratio from bulk (k) and shear (g) moduli: nu = (3K - 2G) / (6K + 2G).
 * @param {number} bulk
 * @param {number} shear
 * @returns {number}
 */
export function elastic_poisson_ratio(bulk, shear) {
    const ret = wasm.elastic_poisson_ratio(bulk, shear);
    return ret;
}

/**
 * Compute Voigt-Reuss-Hill shear modulus from 6x6 elastic tensor.
 *
 * tensor: flat array of 36 elements in row-major order
 * @param {Float64Array} tensor
 * @returns {WasmResult}
 */
export function elastic_shear_modulus(tensor) {
    const ptr0 = passArrayF64ToWasm0(tensor, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.elastic_shear_modulus(ptr0, len0);
    return ret;
}

/**
 * Convert 3x3 strain tensor to 6-element Voigt notation [xx, yy, zz, 2*yz, 2*xz, 2*xy].
 * @param {JsMatrix3x3} strain
 * @returns {Float64Array}
 */
export function elastic_strain_to_voigt(strain) {
    const ret = wasm.elastic_strain_to_voigt(strain);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Convert 3x3 stress tensor to 6-element Voigt notation [xx, yy, zz, yz, xz, xy].
 * @param {JsMatrix3x3} stress
 * @returns {Float64Array}
 */
export function elastic_stress_to_voigt(stress) {
    const ret = wasm.elastic_stress_to_voigt(stress);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Compute 6x6 elastic tensor from stress-strain data using SVD pseudoinverse.
 *
 * Returns flat array of 36 elements in row-major order (compatible with
 * elastic_bulk_modulus, elastic_shear_modulus, elastic_is_stable).
 * @param {JsMatrix3x3[]} strains
 * @param {JsMatrix3x3[]} stresses
 * @returns {WasmResult}
 */
export function elastic_tensor_from_stresses(strains, stresses) {
    const ptr0 = passArrayJsValueToWasm0(strains, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(stresses, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.elastic_tensor_from_stresses(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Compute Young's modulus from bulk (k) and shear (g) moduli: E = 9KG / (3K + G).
 * @param {number} bulk
 * @param {number} shear
 * @returns {number}
 */
export function elastic_youngs_modulus(bulk, shear) {
    const ret = wasm.elastic_youngs_modulus(bulk, shear);
    return ret;
}

/**
 * Compute Zener anisotropy ratio for cubic crystals: A = 2*C44 / (C11 - C12).
 * A = 1 for isotropic materials.
 * @param {number} c11
 * @param {number} c12
 * @param {number} c44
 * @returns {number}
 */
export function elastic_zener_ratio(c11, c12, c44) {
    const ret = wasm.elastic_zener_ratio(c11, c12, c44);
    return ret;
}

/**
 * Perform one FIRE optimization step with provided forces.
 * @param {JsFireState} state
 * @param {Float64Array} forces
 * @returns {WasmResult}
 */
export function fire_step_with_forces(state, forces) {
    _assertClass(state, JsFireState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fire_step_with_forces(state.__wbg_ptr, ptr0, len0);
    return ret;
}

/**
 * Get a hash of the reduced formula (ignores oxidation states).
 *
 * Useful for grouping compositions by formula.
 * @param {string} formula
 * @returns {WasmResult}
 */
export function formula_hash(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.formula_hash(ptr0, len0);
    return ret;
}

/**
 * Get fractional composition (atomic fractions) as array of {element, amount} objects.
 *
 * Note: Returns element symbols only (e.g., "Fe"), stripping any oxidation states.
 * Use `parse_composition` if you need to preserve species with oxidation states.
 * @param {string} formula
 * @returns {WasmResult}
 */
export function fractional_composition(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.fractional_composition(ptr0, len0);
    return ret;
}

/**
 * Generate a slab from a bulk structure using local slab.rs implementation.
 * This is the CatGO-specific slab generation with offset/thickness/vacuum parameters.
 * @param {string} structure_json
 * @param {number} h
 * @param {number} k
 * @param {number} l
 * @param {number} offset
 * @param {number} thickness
 * @param {number} vacuum
 * @param {string} growth_mode
 * @param {number} supercell_a
 * @param {number} supercell_b
 * @returns {WasmResult}
 */
export function generate_slab(structure_json, h, k, l, offset, thickness, vacuum, growth_mode, supercell_a, supercell_b) {
    const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(growth_mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.generate_slab(ptr0, len0, h, k, l, offset, thickness, vacuum, ptr1, len1, supercell_a, supercell_b);
    return ret;
}

/**
 * Generate multiple slabs with different terminations.
 * @param {JsCrystal} structure
 * @param {JsMillerIndex} miller_index
 * @param {number} min_slab_size
 * @param {number} min_vacuum_size
 * @param {boolean} center_slab
 * @param {boolean} in_unit_planes
 * @param {boolean} primitive
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function generate_slabs(structure, miller_index, min_slab_size, min_vacuum_size, center_slab, in_unit_planes, primitive, symprec) {
    const ret = wasm.generate_slabs(structure, miller_index, min_slab_size, min_vacuum_size, center_slab, in_unit_planes, primitive, symprec);
    return ret;
}

/**
 * Get atomic fraction of an element in a composition.
 *
 * Returns the atomic fraction (0.0 to 1.0) or 0.0 if element not present.
 * @param {string} formula
 * @param {string} element
 * @returns {WasmResult}
 */
export function get_atomic_fraction(formula, element) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(element, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.get_atomic_fraction(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Get atomic mass for an element by symbol.
 * @param {string} symbol
 * @returns {WasmResult}
 */
export function get_atomic_mass(symbol) {
    const ptr0 = passStringToWasm0(symbol, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.get_atomic_mass(ptr0, len0);
    return ret;
}

/**
 * Get atomic scattering parameters (Cromer-Mann coefficients).
 *
 * Returns the raw JSON string of scattering parameters for all elements.
 * This is the same data embedded in the WASM module, exposed for users
 * who need programmatic access to the coefficients.
 * @returns {string}
 */
export function get_atomic_scattering_params() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.get_atomic_scattering_params();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Get the conventional cell of a structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_conventional(structure, symprec) {
    const ret = wasm.get_conventional(structure, symprec);
    return ret;
}

/**
 * Get coordination number for a specific site.
 * @param {JsCrystal} structure
 * @param {number} site_index
 * @param {number} cutoff
 * @returns {WasmResult}
 */
export function get_coordination_number(structure, site_index, cutoff) {
    const ret = wasm.get_coordination_number(structure, site_index, cutoff);
    return ret;
}

/**
 * Get coordination numbers for all sites using cutoff-based method.
 * @param {JsCrystal} structure
 * @param {number} cutoff
 * @returns {WasmResult}
 */
export function get_coordination_numbers(structure, cutoff) {
    const ret = wasm.get_coordination_numbers(structure, cutoff);
    return ret;
}

/**
 * Get the crystal system of a structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_crystal_system(structure, symprec) {
    const ret = wasm.get_crystal_system(structure, symprec);
    return ret;
}

/**
 * Get the density of the structure in g/cm³.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_density(structure) {
    const ret = wasm.get_density(structure);
    return ret;
}

/**
 * Get distance between two sites using minimum image convention.
 * @param {JsCrystal} structure
 * @param {number} site_idx_1
 * @param {number} site_idx_2
 * @returns {WasmResult}
 */
export function get_distance(structure, site_idx_1, site_idx_2) {
    const ret = wasm.get_distance(structure, site_idx_1, site_idx_2);
    return ret;
}

/**
 * Get the full distance matrix between all sites.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_distance_matrix(structure) {
    const ret = wasm.get_distance_matrix(structure);
    return ret;
}

/**
 * Get electronegativity for an element by symbol.
 * @param {string} symbol
 * @returns {WasmResult}
 */
export function get_electronegativity(symbol) {
    const ptr0 = passStringToWasm0(symbol, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.get_electronegativity(ptr0, len0);
    return ret;
}

/**
 * Get equivalent site indices (orbits from symmetry analysis).
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_equivalent_sites(structure, symprec) {
    const ret = wasm.get_equivalent_sites(structure, symprec);
    return ret;
}

/**
 * Get the Hall number for spacegroup identification.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_hall_number(structure, symprec) {
    const ret = wasm.get_hall_number(structure, symprec);
    return ret;
}

/**
 * Get the inverse of the lattice matrix.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_lattice_inv_matrix(structure) {
    const ret = wasm.get_lattice_inv_matrix(structure);
    return ret;
}

/**
 * Get the metric tensor G = A * A^T of the lattice.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_lattice_metric_tensor(structure) {
    const ret = wasm.get_lattice_metric_tensor(structure);
    return ret;
}

/**
 * Get the transformation matrix to LLL-reduced basis.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_lll_mapping(structure) {
    const ret = wasm.get_lll_mapping(structure);
    return ret;
}

/**
 * Get the LLL-reduced lattice matrix.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_lll_reduced_lattice(structure) {
    const ret = wasm.get_lll_reduced_lattice(structure);
    return ret;
}

/**
 * Get local environment (neighbors) for a specific site.
 * @param {JsCrystal} structure
 * @param {number} site_index
 * @param {number} cutoff
 * @returns {WasmResult}
 */
export function get_local_environment(structure, site_index, cutoff) {
    const ret = wasm.get_local_environment(structure, site_index, cutoff);
    return ret;
}

/**
 * Get neighbor list for a structure.
 * @param {JsCrystal} structure
 * @param {number} cutoff_radius
 * @param {number} numerical_tol
 * @param {boolean} exclude_self
 * @returns {WasmResult}
 */
export function get_neighbor_list(structure, cutoff_radius, numerical_tol, exclude_self) {
    const ret = wasm.get_neighbor_list(structure, cutoff_radius, numerical_tol, exclude_self);
    return ret;
}

/**
 * Get the Pearson symbol (e.g., "cF8" for FCC).
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_pearson_symbol(structure, symprec) {
    const ret = wasm.get_pearson_symbol(structure, symprec);
    return ret;
}

/**
 * Get the primitive cell of a structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_primitive(structure, symprec) {
    const ret = wasm.get_primitive(structure, symprec);
    return ret;
}

/**
 * Get the reciprocal lattice matrix (2π convention).
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_reciprocal_lattice(structure) {
    const ret = wasm.get_reciprocal_lattice(structure);
    return ret;
}

/**
 * Get structure with reduced lattice (Niggli or LLL algorithm).
 * @param {JsCrystal} structure
 * @param {JsReductionAlgo} algo
 * @returns {WasmResult}
 */
export function get_reduced_structure(structure, algo) {
    const ret = wasm.get_reduced_structure(structure, algo);
    return ret;
}

/**
 * Get site symmetry symbols for each site.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_site_symmetry_symbols(structure, symprec) {
    const ret = wasm.get_site_symmetry_symbols(structure, symprec);
    return ret;
}

/**
 * Get a sorted copy of the structure by electronegativity.
 * @param {JsCrystal} structure
 * @param {boolean} reverse
 * @returns {WasmResult}
 */
export function get_sorted_by_electronegativity(structure, reverse) {
    const ret = wasm.get_sorted_by_electronegativity(structure, reverse);
    return ret;
}

/**
 * Get a sorted copy of the structure by atomic number.
 * @param {JsCrystal} structure
 * @param {boolean} reverse
 * @returns {WasmResult}
 */
export function get_sorted_structure(structure, reverse) {
    const ret = wasm.get_sorted_structure(structure, reverse);
    return ret;
}

/**
 * Get the spacegroup number of a structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_spacegroup_number(structure, symprec) {
    const ret = wasm.get_spacegroup_number(structure, symprec);
    return ret;
}

/**
 * Get the spacegroup symbol of a structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_spacegroup_symbol(structure, symprec) {
    const ret = wasm.get_spacegroup_symbol(structure, symprec);
    return ret;
}

/**
 * Get metadata about a structure (formula, volume, etc.).
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_structure_metadata(structure) {
    const ret = wasm.get_structure_metadata(structure);
    return ret;
}

/**
 * Get the full symmetry dataset for a structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_symmetry_dataset(structure, symprec) {
    const ret = wasm.get_symmetry_dataset(structure, symprec);
    return ret;
}

/**
 * Get symmetry operations for the structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_symmetry_operations(structure, symprec) {
    const ret = wasm.get_symmetry_operations(structure, symprec);
    return ret;
}

/**
 * Get the total mass of the structure in atomic mass units.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_total_mass(structure) {
    const ret = wasm.get_total_mass(structure);
    return ret;
}

/**
 * Get the volume of the unit cell in Angstrom³.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function get_volume(structure) {
    const ret = wasm.get_volume(structure);
    return ret;
}

/**
 * Get weight fraction of an element in a composition.
 *
 * Returns the weight fraction (0.0 to 1.0) or 0.0 if element not present.
 * @param {string} formula
 * @param {string} element
 * @returns {WasmResult}
 */
export function get_wt_fraction(formula, element) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(element, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.get_wt_fraction(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Get Wyckoff letters for each site in the structure.
 * @param {JsCrystal} structure
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function get_wyckoff_letters(structure, symprec) {
    const ret = wasm.get_wyckoff_letters(structure, symprec);
    return ret;
}

/**
 * Interpolate between two structures.
 * @param {JsCrystal} start
 * @param {JsCrystal} end
 * @param {number} n_images
 * @param {boolean} interpolate_lattices
 * @param {boolean} use_pbc
 * @returns {WasmResult}
 */
export function interpolate_structures(start, end, n_images, interpolate_lattices, use_pbc) {
    const ret = wasm.interpolate_structures(start, end, n_images, interpolate_lattices, use_pbc);
    return ret;
}

/**
 * Check if a composition is charge-balanced.
 *
 * Returns null if any species lacks an oxidation state.
 * @param {string} formula
 * @returns {WasmResult}
 */
export function is_charge_balanced(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.is_charge_balanced(ptr0, len0);
    return ret;
}

/**
 * Check if two sites are periodic images of each other.
 * @param {JsCrystal} structure
 * @param {number} site_i
 * @param {number} site_j
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function is_periodic_image(structure, site_i, site_j, tolerance) {
    const ret = wasm.is_periodic_image(structure, site_i, site_j, tolerance);
    return ret;
}

/**
 * Perform one Langevin dynamics step (for use with JS force callback).
 *
 * This version takes forces directly rather than a callback,
 * since JS callbacks across WASM boundary are complex.
 * @param {JsLangevinIntegrator} integrator
 * @param {JsMDState} state
 * @param {Float64Array} forces
 * @returns {WasmResult}
 */
export function langevin_step_with_forces(integrator, state, forces) {
    _assertClass(integrator, JsLangevinIntegrator);
    _assertClass(state, JsMDState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.langevin_step_with_forces(integrator.__wbg_ptr, state.__wbg_ptr, ptr0, len0);
    return ret;
}

/**
 * Generate a single slab from a bulk structure.
 * @param {JsCrystal} structure
 * @param {JsMillerIndex} miller_index
 * @param {number} min_slab_size
 * @param {number} min_vacuum_size
 * @param {boolean} center_slab
 * @param {boolean} in_unit_planes
 * @param {boolean} primitive
 * @param {number} symprec
 * @param {number | null} [termination_index]
 * @returns {WasmResult}
 */
export function make_slab(structure, miller_index, min_slab_size, min_vacuum_size, center_slab, in_unit_planes, primitive, symprec, termination_index) {
    const ret = wasm.make_slab(structure, miller_index, min_slab_size, min_vacuum_size, center_slab, in_unit_planes, primitive, symprec, isLikeNone(termination_index) ? 0x100000001 : (termination_index) >>> 0);
    return ret;
}

/**
 * Create a supercell using a 3x3 transformation matrix.
 * @param {JsCrystal} structure
 * @param {JsIntMatrix3x3} matrix
 * @returns {WasmResult}
 */
export function make_supercell(structure, matrix) {
    const ret = wasm.make_supercell(structure, matrix);
    return ret;
}

/**
 * Create a diagonal supercell (nx × ny × nz).
 * @param {JsCrystal} structure
 * @param {number} scale_a
 * @param {number} scale_b
 * @param {number} scale_c
 * @returns {WasmResult}
 */
export function make_supercell_diag(structure, scale_a, scale_b, scale_c) {
    const ret = wasm.make_supercell_diag(structure, scale_a, scale_b, scale_c);
    return ret;
}

/**
 * Complete the velocity Verlet step after computing new forces.
 * @param {JsMDState} state
 * @param {Float64Array} new_forces
 * @param {number} dt_fs
 * @returns {WasmResult}
 */
export function md_velocity_verlet_finalize(state, new_forces, dt_fs) {
    _assertClass(state, JsMDState);
    const ptr0 = passArrayF64ToWasm0(new_forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.md_velocity_verlet_finalize(state.__wbg_ptr, ptr0, len0, dt_fs);
    return ret;
}

/**
 * Perform one velocity Verlet MD step (half-step velocity update + full position update).
 *
 * This function updates positions and velocities in-place. The caller must:
 * 1. Call this function with current forces
 * 2. Compute new forces at the updated positions
 * 3. Call `md_velocity_verlet_finish` with new forces to complete the velocity update
 *
 * forces: flat array of current forces [Fx0, Fy0, Fz0, ...] in eV/Angstrom
 * dt_fs: timestep in femtoseconds (must be finite and positive)
 * @param {JsMDState} state
 * @param {Float64Array} forces
 * @param {number} dt_fs
 * @returns {WasmResult}
 */
export function md_velocity_verlet_step(state, forces, dt_fs) {
    _assertClass(state, JsMDState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.md_velocity_verlet_step(state.__wbg_ptr, ptr0, len0, dt_fs);
    return ret;
}

/**
 * Convert Miller index to normal vector using local slab.rs implementation.
 * @param {string} structure_json
 * @param {number} h
 * @param {number} k
 * @param {number} l
 * @returns {string}
 */
export function miller_to_normal(structure_json, h, k, l) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.miller_to_normal(ptr0, len0, h, k, l);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Convert a pymatgen Molecule JSON to ASE Atoms dict format.
 * @param {string} molecule_json
 * @returns {WasmResult}
 */
export function molecule_to_ase(molecule_json) {
    const ptr0 = passStringToWasm0(molecule_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.molecule_to_ase(ptr0, len0);
    return ret;
}

/**
 * Convert a molecule to XYZ format string.
 * @param {string} json
 * @param {string | null} [comment]
 * @returns {WasmResult}
 */
export function molecule_to_xyz_str(json, comment) {
    const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(comment) ? 0 : passStringToWasm0(comment, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.molecule_to_xyz_str(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Perform one Nose-Hoover chain step with provided forces.
 * @param {JsNoseHooverChain} thermostat
 * @param {JsMDState} state
 * @param {Float64Array} forces
 * @returns {WasmResult}
 */
export function nose_hoover_step_with_forces(thermostat, state, forces) {
    _assertClass(thermostat, JsNoseHooverChain);
    _assertClass(state, JsMDState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.nose_hoover_step_with_forces(thermostat.__wbg_ptr, state.__wbg_ptr, ptr0, len0);
    return ret;
}

/**
 * Perform one NPT step with provided forces and stress.
 * @param {JsNPTIntegrator} integrator
 * @param {JsNPTState} state
 * @param {Float64Array} forces
 * @param {Float64Array} stress
 * @returns {WasmResult}
 */
export function npt_step_with_forces_and_stress(integrator, state, forces, stress) {
    _assertClass(integrator, JsNPTIntegrator);
    _assertClass(state, JsNPTState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(stress, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.npt_step_with_forces_and_stress(integrator.__wbg_ptr, state.__wbg_ptr, ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Optimize a structure using the full UFF force field (uff-relax crate).
 *
 * Takes a pymatgen-format JSON structure and optional JSON config:
 * ```json
 * {
 *   "max_steps": 200,     // FIRE iterations (default: 200)
 *   "fmax": 0.5,          // force threshold kcal/mol/A (default: 0.5)
 *   "cutoff": 6.0,        // non-bonded cutoff A (default: 6.0)
 *   "bond_tolerance": 0.45 // covalent radii tolerance (default: 0.45)
 * }
 * ```
 *
 * Returns JSON with optimized structure and metadata:
 * ```json
 * {
 *   "structure": { ... },
 *   "converged": true,
 *   "final_energy": -123.4,
 *   "final_fmax": 0.05,
 *   "energy_terms": { "bond": ..., "angle": ..., "torsion": ..., "non_bonded": ..., "total": ... },
 *   "iterations": 200
 * }
 * ```
 * @param {string} structure_json
 * @param {string | null} [options_json]
 * @returns {WasmResult}
 */
export function optimize_structure_uff(structure_json, options_json) {
    const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(options_json) ? 0 : passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.optimize_structure_uff(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Optimize a structure using VSEPR geometry theory (vsepr-rs crate).
 *
 * VSEPR is a fast pre-optimizer that arranges atoms into chemically sensible
 * geometries based on Valence Shell Electron Pair Repulsion theory. Best for
 * small molecules, especially when starting from overlapping or random coordinates.
 *
 * Takes a pymatgen-format JSON structure and optional JSON config:
 * ```json
 * {
 *   "iterations": 1500,      // optimization steps (default: 1500)
 *   "force_constant": 0.15,  // movement scaling (default: 0.15)
 *   "bond_tolerance": 0.45   // covalent radii tolerance (default: 0.45)
 * }
 * ```
 *
 * Returns JSON with optimized structure:
 * ```json
 * {
 *   "structure": { ... }
 * }
 * ```
 * @param {string} structure_json
 * @param {string | null} [options_json]
 * @returns {WasmResult}
 */
export function optimize_structure_vsepr(structure_json, options_json) {
    const ptr0 = passStringToWasm0(structure_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(options_json) ? 0 : passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.optimize_structure_vsepr(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Parse ASE Atoms dict and determine if it's a Structure or Molecule.
 *
 * Returns { type: "Structure" | "Molecule", data: pymatgen_json_string }.
 * @param {JsAseAtoms} ase_atoms
 * @returns {WasmResult}
 */
export function parse_ase_atoms(ase_atoms) {
    const ret = wasm.parse_ase_atoms(ase_atoms);
    return ret;
}

/**
 * Parse a structure from CIF format string.
 * @param {string} content
 * @returns {WasmResult}
 */
export function parse_cif(content) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_cif(ptr0, len0);
    return ret;
}

/**
 * Parse a chemical formula and return composition information.
 *
 * Returns an object with:
 * - species: object mapping element/species symbols to amounts
 * - formula: the input formula normalized
 * - reducedFormula: reduced formula string
 * - formulaAnonymous: anonymous formula (e.g., "A2B3")
 * - formulaHill: Hill notation formula
 * - alphabeticalFormula: alphabetically sorted formula
 * - chemicalSystem: element system (e.g., "Fe-O")
 * - numAtoms: total number of atoms
 * - numElements: number of distinct elements
 * - weight: molecular weight in atomic mass units
 * - isElement: true if composition is a single element
 * - averageElectronegativity: average electronegativity (or null)
 * - totalElectrons: total number of electrons
 * @param {string} formula
 * @returns {WasmResult}
 */
export function parse_composition(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_composition(ptr0, len0);
    return ret;
}

/**
 * Parse a molecule from pymatgen Molecule JSON string.
 *
 * Returns the parsed molecule JSON string in pymatgen-compatible format.
 * @param {string} json
 * @returns {WasmResult}
 */
export function parse_molecule_json(json) {
    const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_molecule_json(ptr0, len0);
    return ret;
}

/**
 * Parse a structure from POSCAR format string.
 * @param {string} content
 * @returns {WasmResult}
 */
export function parse_poscar(content) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_poscar(ptr0, len0);
    return ret;
}

/**
 * Parse a molecule from XYZ format string.
 *
 * Returns the molecule JSON string in pymatgen Molecule.as_dict() format.
 * @param {string} content
 * @returns {WasmResult}
 */
export function parse_xyz_str(content) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_xyz_str(ptr0, len0);
    return ret;
}

/**
 * Perturb all sites by random vectors.
 * @param {JsCrystal} structure
 * @param {number} distance
 * @param {number | null} [min_distance]
 * @param {bigint | null} [seed]
 * @returns {WasmResult}
 */
export function perturb_structure(structure, distance, min_distance, seed) {
    const ret = wasm.perturb_structure(structure, distance, !isLikeNone(min_distance), isLikeNone(min_distance) ? 0 : min_distance, !isLikeNone(seed), isLikeNone(seed) ? BigInt(0) : seed);
    return ret;
}

/**
 * Get reduced composition as array of {element, amount} objects.
 *
 * Note: Returns element symbols only (e.g., "Fe"), stripping any oxidation states.
 * Use `parse_composition` if you need to preserve species with oxidation states.
 * @param {string} formula
 * @returns {WasmResult}
 */
export function reduced_composition(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.reduced_composition(ptr0, len0);
    return ret;
}

/**
 * Remove sites at specific indices.
 * @param {JsCrystal} structure
 * @param {Uint32Array} indices
 * @returns {WasmResult}
 */
export function remove_sites(structure, indices) {
    const ptr0 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.remove_sites(structure, ptr0, len0);
    return ret;
}

/**
 * Remove all sites containing any of the specified species.
 * @param {JsCrystal} structure
 * @param {string[]} species
 * @returns {WasmResult}
 */
export function remove_species(structure, species) {
    const ptr0 = passArrayJsValueToWasm0(species, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.remove_species(structure, ptr0, len0);
    return ret;
}

/**
 * Get a hash of the composition including oxidation states.
 *
 * Useful for exact matching of compositions.
 * @param {string} formula
 * @returns {WasmResult}
 */
export function species_hash(formula) {
    const ptr0 = passStringToWasm0(formula, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.species_hash(ptr0, len0);
    return ret;
}

/**
 * Convert a pymatgen Structure to ASE Atoms dict format.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function structure_to_ase(structure) {
    const ret = wasm.structure_to_ase(structure);
    return ret;
}

/**
 * Convert structure to CIF format string.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function structure_to_cif(structure) {
    const ret = wasm.structure_to_cif(structure);
    return ret;
}

/**
 * Serialize structure to pymatgen-compatible JSON string.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function structure_to_json(structure) {
    const ret = wasm.structure_to_json(structure);
    return ret;
}

/**
 * Convert structure to POSCAR format string.
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function structure_to_poscar(structure) {
    const ret = wasm.structure_to_poscar(structure);
    return ret;
}

/**
 * Substitute one species with another throughout the structure.
 * @param {JsCrystal} structure
 * @param {string} old_species
 * @param {string} new_species
 * @returns {WasmResult}
 */
export function substitute_species(structure, old_species, new_species) {
    const ptr0 = passStringToWasm0(old_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(new_species, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.substitute_species(structure, ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Calculate surface area of a slab.
 * @param {JsCrystal} slab
 * @returns {WasmResult}
 */
export function surface_area(slab) {
    const ret = wasm.surface_area(slab);
    return ret;
}

/**
 * Calculate surface energy from slab and bulk energies.
 * @param {number} slab_energy
 * @param {number} bulk_energy_per_atom
 * @param {number} n_atoms
 * @param {number} surface_area
 * @returns {number}
 */
export function surface_calculate_energy(slab_energy, bulk_energy_per_atom, n_atoms, surface_area) {
    const ret = wasm.surface_calculate_energy(slab_energy, bulk_energy_per_atom, n_atoms, surface_area);
    return ret;
}

/**
 * Compute Wulff shape from surface energies.
 *
 * surface_energies_json: JSON array of [[h,k,l], energy] pairs.
 * Returns JSON object with facets, total_surface_area, volume, sphericity.
 * @param {JsCrystal} structure
 * @param {string} surface_energies_json
 * @returns {WasmResult}
 */
export function surface_compute_wulff(structure, surface_energies_json) {
    const ptr0 = passStringToWasm0(surface_energies_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.surface_compute_wulff(structure, ptr0, len0);
    return ret;
}

/**
 * Enumerate all unique Miller indices up to a maximum index value.
 *
 * Returns JSON array of [h, k, l] arrays.
 * @param {number} max_index
 * @returns {WasmResult}
 */
export function surface_enumerate_miller(max_index) {
    const ret = wasm.surface_enumerate_miller(max_index);
    return ret;
}

/**
 * Enumerate all unique surface terminations for a Miller index.
 *
 * Returns JSON array of termination objects with miller_index, shift,
 * surface_species, surface_density, is_polar, and slab structure.
 * @param {JsCrystal} structure
 * @param {number} h
 * @param {number} k
 * @param {number} l
 * @param {number} min_slab
 * @param {number} min_vacuum
 * @param {number} symprec
 * @returns {WasmResult}
 */
export function surface_enumerate_terminations(structure, h, k, l, min_slab, min_vacuum, symprec) {
    const ret = wasm.surface_enumerate_terminations(structure, h, k, l, min_slab, min_vacuum, symprec);
    return ret;
}

/**
 * Find adsorption sites on a slab surface.
 *
 * Returns JSON array of adsorption site objects.
 * @param {JsCrystal} slab
 * @param {number} height
 * @param {string} site_types_json
 * @param {number | null} [neighbor_cutoff]
 * @param {number | null} [surface_tolerance]
 * @returns {WasmResult}
 */
export function surface_find_adsorption_sites(slab, height, site_types_json, neighbor_cutoff, surface_tolerance) {
    const ptr0 = passStringToWasm0(site_types_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.surface_find_adsorption_sites(slab, height, ptr0, len0, !isLikeNone(neighbor_cutoff), isLikeNone(neighbor_cutoff) ? 0 : neighbor_cutoff, !isLikeNone(surface_tolerance), isLikeNone(surface_tolerance) ? 0 : surface_tolerance);
    return ret;
}

/**
 * Get surface atoms in a slab structure.
 *
 * Returns JSON array of site indices.
 * @param {JsCrystal} slab
 * @param {number} tolerance
 * @returns {WasmResult}
 */
export function surface_get_surface_atoms(slab, tolerance) {
    const ret = wasm.surface_get_surface_atoms(slab, tolerance);
    return ret;
}

/**
 * Get the normal vector for a Miller plane.
 *
 * Returns JSON array [x, y, z] of the unit normal.
 * @param {JsCrystal} structure
 * @param {number} h
 * @param {number} k
 * @param {number} l
 * @returns {WasmResult}
 */
export function surface_miller_to_normal(structure, h, k, l) {
    const ret = wasm.surface_miller_to_normal(structure, h, k, l);
    return ret;
}

/**
 * Translate specific sites by a vector.
 * @param {JsCrystal} structure
 * @param {Uint32Array} indices
 * @param {JsVector3} vector
 * @param {boolean} fractional
 * @returns {WasmResult}
 */
export function translate_sites(structure, indices, vector, fractional) {
    const ptr0 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.translate_sites(structure, ptr0, len0, vector, fractional);
    return ret;
}

/**
 * Perform one velocity rescale step with provided forces.
 * @param {JsVelocityRescale} thermostat
 * @param {JsMDState} state
 * @param {Float64Array} forces
 * @returns {WasmResult}
 */
export function velocity_rescale_step_with_forces(thermostat, state, forces) {
    _assertClass(thermostat, JsVelocityRescale);
    _assertClass(state, JsMDState);
    const ptr0 = passArrayF64ToWasm0(forces, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.velocity_rescale_step_with_forces(thermostat.__wbg_ptr, state.__wbg_ptr, ptr0, len0);
    return ret;
}

/**
 * Initialize WASM module — installs panic hook so panics produce
 * readable error messages instead of just "unreachable".
 */
export function wasm_init() {
    wasm.wasm_init();
}

/**
 * Wrap all fractional coordinates to [0, 1).
 * @param {JsCrystal} structure
 * @returns {WasmResult}
 */
export function wrap_to_unit_cell(structure) {
    const ret = wasm.wrap_to_unit_cell(structure);
    return ret;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_04624de7d0e8332d: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8f0eb39a4a4c2f66: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_8fcf4ce7f1ca72a2: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_0bc8482c6e3508ae: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_47fa6863be6f2f25: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_31b12575b56f32fc: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_0095a73b8b156f76: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_5ae8e5880f2c1fbd: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_cd444516edc5b180: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_9e4d92534c42d778: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_11888390b0186270: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_8ff4255516ccad3e: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_72fb696202c56729: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_389efe28435a9388: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_4708e0c13bdc8e95: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_86f2631e91b51511: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_done_57b39ecd9addfe81: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_58c7934c745daac7: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_error_7534b8e9a36f1ab4: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_error_9a7fe3f932034cde: function(arg0) {
            console.error(arg0);
        },
        __wbg_getRandomValues_b3f15fcbfabb0f8b: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_get_9b94d73e6221f75c: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_b3ed3ad4be2bc8ac: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_with_ref_key_1dc361bd10053bfe: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_c367199e2fa2aa04: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_53af74335dec57f4: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_9b9075935c74707c: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_d314bb98fcf08331: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_bfbc7332a9768d2a: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_6ff6560ca1568e55: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_32ed9a279acd054c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_35a7bace40f36eac: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_log_6b5ca2e6124b2808: function(arg0) {
            console.log(arg0);
        },
        __wbg_msCrypto_d562bbe83e0d4b91: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_361308b2356cecd0: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_3eb36ae241fe6f44: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_8a6f238a6ece86ea: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_dca287b076112a51: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_dd2b680c8bf6ae29: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_no_args_1c7c842f08d00ebb: function(arg0, arg1) {
            const ret = new Function(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_a2c39cbe88fd8ff1: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_next_3482f54c49e8af19: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_next_418f80d8f5303233: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_node_e1f24f89a7336c2e: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_3975fd6c72f520aa: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_bdcdcc5842e4d77d: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_f8c153b79f285817: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b74f47fc2d022fd6: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_set_1eb0999cf5d27fc8: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_3f1d0b984ed272ed: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_f43e577aea94465b: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_stack_0ed75d68575b0f3c: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_12837167ad935116: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_e628e89ab3b1c95f: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_a621d3dfbb60d0ce: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f8727f0cf888e0bd: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_a96e1fef17ed23cb: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_value_0546255b415e96c1: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbg_versions_4e31226f5e8dc909: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000005: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./ferrox_bg.js": import0,
    };
}

const JsCellFireStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jscellfirestate_free(ptr >>> 0, 1));
const JsElementFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jselement_free(ptr >>> 0, 1));
const JsFireConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsfireconfig_free(ptr >>> 0, 1));
const JsFireStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsfirestate_free(ptr >>> 0, 1));
const JsLangevinIntegratorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jslangevinintegrator_free(ptr >>> 0, 1));
const JsMDStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsmdstate_free(ptr >>> 0, 1));
const JsMsdCalculatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsmsdcalculator_free(ptr >>> 0, 1));
const JsNPTIntegratorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsnptintegrator_free(ptr >>> 0, 1));
const JsNPTStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsnptstate_free(ptr >>> 0, 1));
const JsNoseHooverChainFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsnosehooverchain_free(ptr >>> 0, 1));
const JsSpeciesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsspecies_free(ptr >>> 0, 1));
const JsVacfCalculatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsvacfcalculator_free(ptr >>> 0, 1));
const JsVelocityRescaleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsvelocityrescale_free(ptr >>> 0, 1));
const WasmStructureMatcherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmstructurematcher_free(ptr >>> 0, 1));

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

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
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

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
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

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
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

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt8ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('ferrox_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
