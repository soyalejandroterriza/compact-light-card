/*
 * EZ Light Card
 *
 * A clean, simple, and highly customisable light card for Home Assistant.
 *
 * Author: goggybox (Modified)
 * License: MIT
 */


console.log("ez-light-card.js loaded! v2 -- CLEAN");
window.left_offset = 0;

class EzLightCard extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this.startX = 0;
        this.startY = 0;
        this.isScrolling = false;
        this._hass = null;
        this.pendingUpdate = null;
        this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          height: 100%;
          --height: 50px; /* Fallback/Min */
          --off-background-colour: var(--secondary-background-color);
          --off-text-colour: var(--secondary-text-color);
          --card-border-colour: var(--card-background-color);
        }

        .card-container {
          width: 100%;
          height: 100%;
          min-height: var(--height);
          background: rgba(0,0,0,0.0);
          border-radius: 12px;
          overflow: hidden;
          cursor: pointer;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }

        .card {
          width: 100%;
          height: 100%;
          background: var(--off-background-colour);
          display: flex;
          align-items: center;
          justify-content: flex-start; /* Align start for icon+text */
          transition: background 0.3s ease;
          position: relative;
          padding-left: 20px; /* Space for content */
          box-sizing: border-box;
        }
        .card.vertical {
          flex-direction: column;
          justify-content: center;
          padding-left: 0;
          text-align: center;
        }
        .card.vertical .name {
          margin-left: 0;
          margin-top: 10px;
        }
        .card.vertical .icon {
          --mdc-icon-size: 64px;
          width: 100%;
          height: auto;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        /* Removed redundant ha-icon rule as .icon covers it */
        
        .card.horizontal-center {
          justify-content: flex-start;
          padding-left: 0;
        }
        
        .card.horizontal-center .icon {
          position: absolute;
          left: 20px;
          top: 50%;
          transform: translateY(-50%);
        }

        .card.horizontal-center .name {
          width: 100%;
          text-align: center;
          margin-left: 0;
          padding: 0 60px; /* Symmetric padding to ensure true center (64px space for icon) */
        }

        .name {
          font-weight: bold;
          font-size: 16px;
          color: var(--off-text-colour);
          pointer-events: none;
          z-index: 1;
          margin-left: 12px; /* Space between icon and text */
        }

        .icon {
          --mdc-icon-size: 24px;
          color: var(--off-text-colour);
          pointer-events: none;
          z-index: 1;
        }

      </style>

      <div class="card-container">
        <div class="card">
          <ha-icon class="icon" icon="mdi:lightbulb"></ha-icon>
          <div class="name">Loading...</div>
        </div>
      </div>
    `
    }

    _hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    _getLuminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }

    _getContrastRatio(colour1, colour2) {
        const lum1 = this._getLuminance(colour1.r, colour1.g, colour1.b);
        const lum2 = this._getLuminance(colour2.r, colour2.g, colour2.b);
        const brightest = Math.max(lum1, lum2);
        const darkest = Math.min(lum1, lum2);
        return (brightest + 0.05) / (darkest + 0.05);
    }

    // convert any colour to RGB values
    _parseColour(colour) {
        // css var -> rgb
        if (colour.startsWith('var(--')) {
            // Get computed value of the CSS variable
            const computedStyle = getComputedStyle(this);
            const varName = colour.match(/var\((--[^)]+)\)/)[1];
            colour = computedStyle.getPropertyValue(varName).trim() || '#000000';
        }

        // hex -> rgb
        if (colour.startsWith('#')) {
            return this._hexToRgb(colour);
        }

        // rgb and rgba
        const rgbMatch = colour.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
        if (rgbMatch) {
            return {
                r: parseInt(rgbMatch[1]),
                g: parseInt(rgbMatch[2]),
                b: parseInt(rgbMatch[3])
            };
        }

        // fallback
        return { r: 0, g: 0, b: 0 };
    }

    // determine whether text colour should be white or black based on contrast with background
    _getTextColourForBackground(backgroundColour) {
        const bgRgb = this._parseColour(backgroundColour);
        const white = { r: 255, g: 255, b: 255 };
        const black = { r: 0, g: 0, b: 0 };

        const contrastWithWhite = this._getContrastRatio(bgRgb, white);
        const contrastWithBlack = this._getContrastRatio(bgRgb, black);

        if (contrastWithWhite >= 1.3) {
            return 'white';
        } else if (contrastWithBlack >= 2.5) {
            return 'black';
        } else {
            // Fallback: choose whichever has higher contrast
            return contrastWithWhite > contrastWithBlack ? 'white' : 'black';
        }
    }

    setConfig(config) {
        if (!config.entity) {
            throw new Error("EZ Light Card: Please provide an 'entity' in the config.")
        }

        this.config = {
            ...config,
            icon: config.icon, // Allow icon override
            name: config.name,
            glow: config.glow !== false,
            off_colours: config.off_colours || null,
            primary_colour: config.primary_colour,
            secondary_colour: config.secondary_colour,
            opacity: config.opacity !== undefined ? Math.max(config.opacity, 0.2) : 1,
            blur: config.blur !== undefined ? Math.min(config.blur, 10) : 0,
        };

        // validate off_colours structure
        if (config.off_colours) {
            if (typeof config.off_colours !== "object" || (config.off_colours.light === undefined && config.off_colours.background === undefined)) {
                throw new Error("EZ Light Card: Invalid off_colours format.");
            }
        }

    }

    _getOffColours() {
        const offColours = this.config.off_colours;
        if (!offColours) return null;

        let bg, text;

        // theme specific
        if (offColours.light && offColours.dark) {
            const isDarkTheme = this._hass.themes.darkMode ?? false;
            const theme = isDarkTheme ? offColours.dark : offColours.light;
            bg = theme.background;
            text = theme.text;
        } else if (offColours.background && offColours.text) {
            bg = offColours.background;
            text = offColours.text;
        } else {
            throw new Error("EZ Light Card: Invalid off_colours format.");
        }

        return { background: bg, text };
    }


    connectedCallback() {
        const card = this.shadowRoot.querySelector(".card-container");

        const handleStart = (clientX, clientY) => {
            clearTimeout(this.holdTimer); // Clear any existing timer
            this.startX = clientX;
            this.startY = clientY;
            this.startTime = Date.now();
            this.isScrolling = false;

            this.holdTimer = setTimeout(() => {
                if (!this.isScrolling) {
                    this._fireMoreInfo();
                    // Mark as handled to prevent tap
                    this.isScrolling = true;
                }
            }, 500);
        };

        const handleMove = (clientX, clientY) => {
            if (this.isScrolling) return;
            const dx = Math.abs(clientX - this.startX);
            const dy = Math.abs(clientY - this.startY);

            // If moved significantly, it's a scroll
            if (dx > 10 || dy > 10) {
                this.isScrolling = true;
                clearTimeout(this.holdTimer);
            }
        };

        const handleEnd = (e) => {
            clearTimeout(this.holdTimer);

            // Prevent double-firing on mobile (stops mouseup from firing after touchend)
            if (e && e.cancelable) {
                e.preventDefault();
            }

            if (this.isScrolling) return;

            const duration = Date.now() - this.startTime;
            if (duration < 500) {
                this._toggleLight();
            }
        };

        // Mouse events
        card.addEventListener("mousedown", (e) => {
            e.preventDefault(); // Prevent native drag/select
            handleStart(e.clientX, e.clientY);
        });
        card.addEventListener("mousemove", (e) => handleMove(e.clientX, e.clientY));
        card.addEventListener("mouseup", handleEnd);
        card.addEventListener("mouseleave", () => {
            clearTimeout(this.holdTimer);
            this.isScrolling = true; // Cancel interaction
        });

        // Touch events
        card.addEventListener("touchstart", (e) => {
            const touch = e.touches[0];
            handleStart(touch.clientX, touch.clientY);
        }, { passive: true }); // passive true to allow scrolling

        card.addEventListener("touchmove", (e) => {
            const touch = e.touches[0];
            handleMove(touch.clientX, touch.clientY);
        }, { passive: true });

        card.addEventListener("touchend", handleEnd);
    }

    _fireMoreInfo() {
        const entityId = this.config.entity;
        const event = new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        });
        this.dispatchEvent(event);
    }

    _toggleLight() {
        if (!this._hass || !this.config.entity) return;
        this._hass.callService("homeassistant", "toggle", {
            entity_id: this.config.entity
        });
    }

    _getCardState() {
        // get the card's current state variables
        if (!this._hass || !this.config.entity) {
            return {
                name: null,
                icon: null,
                isOn: false,
                isUnavailable: false,
                primaryColour: null,
                secondaryColour: null,
            };
        }

        const entity = this.config.entity;
        const stateObj = this._hass.states[entity];

        // ensure entity exists and is connected
        if (!stateObj) {
            return {
                name: "Entity not found",
                icon: "mdi:alert",
                isOn: false,
                isUnavailable: true,
                primaryColour: "#9e9e9e",
                secondaryColour: "#e0e0e0",
            };
        }

        const state = stateObj.state;
        const tempName = this.config.name || stateObj.attributes.friendly_name || entity.replace("light.", "");
        const friendlyName = tempName.length > 30 ? tempName.slice(0, 30) + "..." : tempName;
        const icon = this.config.icon || stateObj.attributes.icon || "mdi:lightbulb";

        const isOn = state === 'on';
        const isUnavailable = state === 'unavailable';

        // determine colour
        let primaryColour = "#ff890e";
        let secondaryColour = "#eec59a";

        // use user's configured colours if provided
        if (this.config.primary_colour) {
            primaryColour = this.config.primary_colour;
        } else if (stateObj.attributes.rgb_color) {
            const [r, g, b] = stateObj.attributes.rgb_color;
            primaryColour = `rgb(${r}, ${g}, ${b})`;
        }
        // Increase opacity for secondary colour (background)
        if (this.config.secondary_colour) {
            secondaryColour = this.config.secondary_colour;
        } else if (stateObj.attributes.rgb_color) {
            const [r, g, b] = stateObj.attributes.rgb_color;
            // WAS: 0.30 opacity. Requested: "MAX".
            // Let's INCREASE it to 0.8 or use a variable if we want to be safe.
            // But user said "Max". Let's try 0.9 for a very solid look but retaining some depth?
            // Or just use the primary color?
            // If we use primary color, text might need to be black/white.
            // Let's try 0.8 which is much stronger than 0.3 but not 100% flat.
            const gradientColour = `rgba(${r}, ${g}, ${b}, 0.8)`;
            secondaryColour = `linear-gradient(${gradientColour}, ${gradientColour}), var(--secondary-background-color)`;
        }

        return {
            name: friendlyName,
            icon,
            isOn,
            isUnavailable,
            primaryColour,
            secondaryColour,
        };

    }

    static getConfigElement() {
        return document.createElement("ez-light-card-editor");
    }

    static getStubConfig(hass) {
        let text = "Luz Ejemplo";
        let entity = "light.example";

        if (hass && hass.states) {
            const lights = Object.keys(hass.states).filter(eid => eid.startsWith("light."));
            if (lights.length > 0) {
                entity = lights[0];
                const state = hass.states[entity];
                text = state.attributes.friendly_name || entity;
            }
        }

        return {
            entity: entity,
            name: text,
            glow: true,
            icon: "mdi:lightbulb",
            show_icon: true,
            outline: false,
            text_colour: "",
            font_size: "",
            icon_size: "",
            vertical: false,
            horizontal_center: false
        };
    }

    set hass(hass) {
        if (!this.shadowRoot) return;
        this._hass = hass;

        // get and apply off colours if configured
        const offColours = this._getOffColours();
        if (offColours) {
            this.style.setProperty("--off-background-colour", offColours.background);
            this.style.setProperty("--off-text-colour", offColours.text);
        } else {
            // reset variables to defaults as in CSS styling
            this.style.removeProperty("--off-background-colour");
            this.style.removeProperty("--off-text-colour");
        }

        const { name, icon, isOn, isUnavailable, primaryColour, secondaryColour } = this._getCardState();

        // UPDATE CARD
        this._updateDisplay(name, icon, isOn, isUnavailable, primaryColour, secondaryColour);
    }

    _updateDisplay(name, icon, isOn, isUnavailable, primaryColour, secondaryColour) {
        const root = this.shadowRoot;
        if (!root) return;

        const cardEl = root.querySelector(".card");

        // Handle Vertical Mode
        if (this.config.vertical) {
            cardEl.classList.add("vertical");
            cardEl.classList.remove("horizontal-center");
        } else {
            cardEl.classList.remove("vertical");
            if (this.config.horizontal_center) {
                cardEl.classList.add("horizontal-center");
            } else {
                cardEl.classList.remove("horizontal-center");
            }
        }

        const nameEl = root.querySelector(".name");
        const iconEl = root.querySelector(".icon");
        const cardContainer = root.querySelector(".card-container");

        if (nameEl) nameEl.textContent = name;

        // Handle Icon Visibility
        if (iconEl) {
            if (this.config.show_icon === false) {
                iconEl.style.display = "none";
                // Remove padding from card if icon is hidden to align text?
                // Current CSS: .card { padding-left: 20px; } .name { margin-left: 12px; }
                // If hidden, maybe reduce padding?
                // Let's keep it simple for now, or maybe set display none.
            } else {
                iconEl.style.display = "block";
                iconEl.setAttribute("icon", icon);
            }
        }

        let targetBg, targetText;

        if (!isOn || isUnavailable) {
            // OFF State
            cardEl.style.background = "var(--off-background-colour)";
            const offBgVal = getComputedStyle(this).getPropertyValue('--off-background-colour').trim();
            const textColour = this._getTextColourForBackground(offBgVal) === 'white' ? '#ffffff' : 'var(--off-text-colour)';

            nameEl.style.color = textColour;
            if (iconEl) iconEl.style.color = textColour;

            cardContainer.style.boxShadow = "none";
        } else {
            // ON State
            cardEl.style.background = secondaryColour;

            // For Smart Font Colour:
            // If background is dark (high opacity red), white text is good.
            // If background is light (high opacity yellow), black text is good.
            // We need to calculate contrast against 'primaryColour' roughly since secondary is derived from it.

            // Or we check smart_font_colour config.

            // Let's assume we want readable text.
            const bgContrastCheck = primaryColour; // Approximation
            const optimalTextColour = this._getTextColourForBackground(bgContrastCheck);

            if (this.config.smart_font_colour) {
                // Try to match text to light color OR comfortable contrast?
                // Original matched text to light color.
                // But if background IS the light color (highly opaque), we need CONTRAST.
                // Let's use White or Black.
                nameEl.style.color = optimalTextColour;
                if (iconEl) iconEl.style.color = optimalTextColour;
            } else {
                // If not smart, maybe just white?
                nameEl.style.color = "#ffffff";
                if (iconEl) iconEl.style.color = "#ffffff";
            }

            // Add glow
            if (this.config.glow) {
                const rgbMatch = primaryColour.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (rgbMatch) {
                    const [r, g, b] = [rgbMatch[1], rgbMatch[2], rgbMatch[3]];
                    const glowColor = `rgba(${r}, ${g}, ${b}, ${Math.min(this.config.opacity * 0.6, 0.3)})`;
                    cardContainer.style.boxShadow = `0 0 24px 8px ${glowColor}`;
                } else {
                    cardContainer.style.boxShadow = `0 0 24px 8px ${primaryColour}40`.replace("rgb", "rgba").replace(")", ", 0.3)");
                }
            }
        }

        if (this.config.text_colour) {
            nameEl.style.color = this.config.text_colour;
            if (iconEl) iconEl.style.color = this.config.text_colour;
        }

        // Apply Custom Sizes
        const ensureUnits = (v) => v && /^\d+$/.test(v) ? `${v}px` : v;

        if (this.config.font_size) {
            nameEl.style.fontSize = ensureUnits(this.config.font_size);
        } else {
            nameEl.style.fontSize = "16px"; // Reset to default
        }

        if (this.config.icon_size) {
            const size = ensureUnits(this.config.icon_size);
            if (iconEl) {
                iconEl.style.setProperty("--mdc-icon-size", size);
                // For horizontal mode, clamp width to avoid layout shifts? 
                // We'll let it be auto/sized by the icon itself unless in vertical.
                if (!this.config.vertical) {
                    iconEl.style.width = size;
                } else {
                    iconEl.style.removeProperty("width"); // Vertical always 100%
                }
            }
        } else {
            if (iconEl) {
                iconEl.style.removeProperty("--mdc-icon-size");
                iconEl.style.removeProperty("width");
            }
        }

        // Apply Outline if configured
        if (this.config.outline) {
            cardContainer.style.border = "1px solid black";
        } else {
            cardContainer.style.border = "none";
        }

        // apply opacity
        root.querySelector(".card").style.opacity = this.config.opacity;
        root.querySelector(".card").style.backdropFilter = `blur(${this.config.blur}px)`;
    }
}

// Visual Editor Class
class EzLightCardEditor extends HTMLElement {
    setConfig(config) {
        this._config = config;
        this.render();
    }

    render() {
        if (this._rendered) {
            this._updateValues();
            return;
        }

        this._rendered = true;

        this.innerHTML = `
          <div class="card-config">
            <ha-entity-picker
              label="Entity"
              class="entity-picker"
              allow-custom-entity
            ></ha-entity-picker>
            
            <ha-textfield
              label="Name (Optional)"
              class="name-field"
            ></ha-textfield>
    
            <div class="side-by-side">
                <ha-icon-picker
                  label="Icon"
                  class="icon-picker"
                ></ha-icon-picker>
            </div>
            
            <div class="color-row">
                <input 
                  type="color" 
                  class="text-colour-picker"
                >
                <button class="clear-color-btn" title="Clear Color">✕</button>
                <label class="color-label">Text/Icon Color</label>
            </div>

            <div class="side-by-side">
                <ha-textfield
                  label="Text Size (Default: 16px)"
                  class="font-size-field"
                ></ha-textfield>
                <ha-textfield
                  label="Icon Size (Default: 24px)"
                  class="icon-size-field"
                ></ha-textfield>
            </div>
    
            <div class="switches">
                <ha-formfield label="Glow">
                    <ha-switch class="glow-switch"></ha-switch>
                </ha-formfield>
                <ha-formfield label="Show Icon">
                    <ha-switch class="icon-switch"></ha-switch>
                </ha-formfield>
                <ha-formfield label="Outline (Recommended for light theme)">
                    <ha-switch class="outline-switch"></ha-switch>
                </ha-formfield>
                <ha-formfield label="Vertical Mode (Horizontal is default)">
                    <ha-switch class="vertical-switch"></ha-switch>
                </ha-formfield>
                <ha-formfield label="Center Text (Horizontal Mode)">
                     <ha-switch class="horizontal-center-switch"></ha-switch>
                </ha-formfield>
            </div>
            <style>
                .card-config { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
                ha-textfield, ha-entity-picker { display: block; }
                .side-by-side { display: flex; gap: 16px; align-items: center; }
                .color-row { display: flex; align-items: center; justify-content: flex-start; gap: 12px; }
                .color-label { color: var(--secondary-text-color); font-size: 16px; }
                .text-colour-picker { width: 40px; height: 40px; border: none; padding: 0; background: none; cursor: pointer; }
                .clear-color-btn { background: none; border: 1px solid var(--divider-color); color: var(--primary-text-color); border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; user-select: none; }
                .switches { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
            </style>
          </div>
        `;

        // Add listeners
        // Use value-changed for HA components
        this.querySelector(".entity-picker").addEventListener("value-changed", this._valueChanged.bind(this, "entity"));
        this.querySelector(".name-field").addEventListener("input", this._valueChanged.bind(this, "name"));
        this.querySelector(".font-size-field").addEventListener("input", this._valueChanged.bind(this, "font_size"));
        this.querySelector(".icon-size-field").addEventListener("input", this._valueChanged.bind(this, "icon_size"));
        this.querySelector(".icon-picker").addEventListener("value-changed", this._valueChanged.bind(this, "icon"));
        this.querySelector(".glow-switch").addEventListener("change", this._valueChanged.bind(this, "glow"));
        this.querySelector(".icon-switch").addEventListener("change", this._valueChanged.bind(this, "show_icon"));
        this.querySelector(".outline-switch").addEventListener("change", this._valueChanged.bind(this, "outline"));
        this.querySelector(".vertical-switch").addEventListener("change", this._valueChanged.bind(this, "vertical"));
        this.querySelector(".horizontal-center-switch").addEventListener("change", this._valueChanged.bind(this, "horizontal_center"));

        // Color Picker Logic
        const colorInput = this.querySelector(".text-colour-picker");
        const clearBtn = this.querySelector(".clear-color-btn");

        colorInput.addEventListener("input", (e) => {
            this._valueChanged("text_colour", { target: { value: e.target.value } });
        });

        clearBtn.addEventListener("click", () => {
            this._valueChanged("text_colour", { target: { value: "" } });
            colorInput.value = "#000000"; // Reset visual
        });

        // IMMEDIATE: Apply hass if we already have it
        if (this._hass) {
            // ...
        }

        this._updateValues();
    }

    // ...

    _updateValues() {
        // ...
        const colorInput = this.querySelector(".text-colour-picker");

        // IMMEDIATE: Apply hass if we already have it
        // IMMEDIATE: Apply hass if we already have it
        if (this._hass) {
            const picker = this.querySelector(".entity-picker");
            if (picker) {
                picker.hass = this._hass;
                // picker.includeDomains = ["light", "switch", "group", "input_boolean", "fan"]; 
                // Note: includeDomains might not be needed if allow-custom-entity is on, or we set it to be safe
            }
        }
    }

    set hass(hass) {
        this._hass = hass;
        if (this._rendered) {
            const picker = this.querySelector(".entity-picker");
            if (picker) {
                picker.hass = hass;
            }
        }
    }

    _updateValues() {
        if (!this._config) return;

        const entityPicker = this.querySelector(".entity-picker");
        // Only update if different to avoid loop/reset
        if (entityPicker && entityPicker.value !== this._config.entity) {
            entityPicker.value = this._config.entity;
        }

        const nameField = this.querySelector(".name-field");
        if (nameField && nameField.value !== (this._config.name || '')) {
            nameField.value = this._config.name || '';
        }

        const fontSizeField = this.querySelector(".font-size-field");
        if (fontSizeField && fontSizeField.value !== (this._config.font_size || '')) {
            fontSizeField.value = this._config.font_size || '';
        }

        const iconSizeField = this.querySelector(".icon-size-field");
        if (iconSizeField && iconSizeField.value !== (this._config.icon_size || '')) {
            iconSizeField.value = this._config.icon_size || '';
        }

        const colorInput = this.querySelector(".text-colour-picker");

        if (this._config.text_colour) {
            if (colorInput && this._config.text_colour.startsWith("#")) colorInput.value = this._config.text_colour;
        } else {
            if (colorInput) colorInput.value = "#000000";
        }

        const iconPicker = this.querySelector(".icon-picker");
        if (iconPicker && iconPicker.value !== (this._config.icon || '')) {
            iconPicker.value = this._config.icon || '';
        }

        const glowSwitch = this.querySelector(".glow-switch");
        if (glowSwitch) glowSwitch.checked = this._config.glow !== false;

        const iconSwitch = this.querySelector(".icon-switch");
        if (iconSwitch) iconSwitch.checked = this._config.show_icon !== false;

        const outlineSwitch = this.querySelector(".outline-switch");
        if (outlineSwitch) outlineSwitch.checked = this._config.outline === true;

        const verticalSwitch = this.querySelector(".vertical-switch");
        if (verticalSwitch) verticalSwitch.checked = this._config.vertical === true;

        const hCenterSwitch = this.querySelector(".horizontal-center-switch");
        if (hCenterSwitch) hCenterSwitch.checked = this._config.horizontal_center === true;
    }

    _valueChanged(key, ev) {
        if (!this._config || !this._hass) return;

        const target = ev.target;
        let value;

        // Prioritize event detail value (for HA components like entity-picker)
        if (ev.detail && ev.detail.value !== undefined) {
            value = ev.detail.value;
        } else if (target.checked !== undefined) {
            value = target.checked;
        } else {
            value = target.value;
        }

        if (this._config[key] === value) return;

        const newConfig = { ...this._config };

        if (value === "" && key !== 'glow' && key !== 'show_icon' && key !== 'outline' && key !== 'vertical' && key !== 'horizontal_center') {
            delete newConfig[key];
        } else {
            newConfig[key] = value;
        }

        this._config = newConfig;

        const event = new CustomEvent("config-changed", {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
        });
        this.dispatchEvent(event);
    }
}

customElements.define("ez-light-card-editor", EzLightCardEditor);

// register card
customElements.define('ez-light-card', EzLightCard);

// make it appear in visual card picker
window.customCards = window.customCards || [];
window.customCards.push({
    type: "ez-light-card",
    name: "EZ Light Card",
    description: "A simple, ez light card.",
    preview: true, // Optional: enables preview in picker
});
