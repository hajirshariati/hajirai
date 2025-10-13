/**
 * Country Selector Component
 * Handles the country/localization selection modal functionality
 */

(() => {
  /**
   * Custom element for localization form
   * Extends HTMLElement to create a web component
   */
  class LocalizationForm extends HTMLElement {
    constructor() {
      super();
      this.elements = {};
    }

    /**
     * Called when the element is added to the DOM
     * This is where we cache elements and bind event listeners
     */
    connectedCallback() {
      // Cache DOM elements for performance
      this.elements = {
        button: this.querySelector('button'),
        modal: this.querySelector('.country-selector_modal'),
        select: this.querySelector('#countrySelect'),
        saveBtn: this.querySelector('#country-selector__save-btn'),
        input: this.querySelector('#selected-country-code'),
        close: this.querySelector('.country-selector_modal--close')
      };

      // Bind event listeners with null checks
      if (this.elements.button) {
        this.elements.button.addEventListener('click', this.openModal.bind(this));
      }
      if (this.elements.saveBtn) {
        this.elements.saveBtn.addEventListener('click', this.onSave.bind(this));
      }
      if (this.elements.modal) {
        this.elements.modal.addEventListener('click', this.onModalClick.bind(this));
      }
      this.addEventListener('keyup', this.onContainerKeyUp.bind(this));
    }

    /**
     * Closes the modal and restores body scroll
     */
    closeModal() {
      this.elements.button.setAttribute('aria-expanded', 'false');
      this.elements.modal.classList.remove('active');

      const body = document.querySelector('body');
      if (body) {
        body.classList.remove('no-scroll');
      }
    }

    /**
     * Handles keyboard events on the container
     * @param {KeyboardEvent} event - The keyboard event
     */
    onContainerKeyUp(event) {
      if (event.code.toUpperCase() === 'ESCAPE') {
        this.closeModal();
        this.elements.button.focus();
      }
    }

    /**
     * Handles clicks on the modal overlay
     * Closes modal if clicking on backdrop or close button
     * @param {MouseEvent} event - The click event
     */
    onModalClick(event) {
      if (!this.elements.modal.classList.contains('active')) {
        return;
      }

      // Close if clicking on modal backdrop or close button
      if (event.target === this.elements.modal ||
          event.target.closest('.country-selector_modal--close')) {
        this.closeModal();
      }
    }

    /**
     * Handles the save button click
     * Updates the hidden input and submits the form
     * @param {Event} event - The click event
     */
    onSave(event) {
      event.preventDefault();

      const form = this.querySelector('form');
      this.elements.input.value = this.elements.select.value;

      if (form) {
        form.submit();
      }
    }

    /**
     * Opens the modal and prevents body scroll
     */
    openModal() {
      this.elements.button.focus();
      this.elements.modal.classList.add('active');

      // Toggle aria-expanded attribute
      const isExpanded = this.elements.button.getAttribute('aria-expanded') === 'false';
      this.elements.button.setAttribute('aria-expanded', isExpanded.toString());

      const body = document.querySelector('body');
      if (body) {
        body.classList.add('no-scroll');
      }
    }
  }

  // Register the custom element if not already registered
  if (!customElements.get('localization-form')) {
    customElements.define('localization-form', LocalizationForm);
  }
})();
