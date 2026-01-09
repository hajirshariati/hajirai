/**
 * Add to Cart Button Manager
 * Handles button state for products with Size/Width options
 */

class AddToCartButtonManager {
  constructor() {
    this.mainButton = null;
    this.stickyButton = null;
    this.hasSizeOption = false;
    this.init();
  }

  init() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.setup());
    } else {
      this.setup();
    }
  }

  setup() {
    this.mainButton = document.querySelector('.product-form__submit');
    this.stickyButton = document.querySelector('.sticky_form__submit');
    
    if (!this.mainButton) return;
    
    // Check if product has size/width option
    this.hasSizeOption = this.mainButton.getAttribute('data-has-size-option') === 'true';
    
    console.log('AddToCartButtonManager initialized, hasSizeOption:', this.hasSizeOption);
    
    // Set initial state immediately
    if (this.hasSizeOption) {
      // Check if a size is already selected
      const selectedSize = document.querySelector('.custom-option-buttons[data-opt-name="Size"]:checked, .custom-option-buttons[data-opt-name="Width"]:checked');
      console.log('Selected size on page load:', selectedSize);
      
      // On initial page load, force uncheck all sizes and show "PLEASE SELECT SIZE"
      const allSizeOptions = document.querySelectorAll('.custom-option-buttons[data-opt-name="Size"], .custom-option-buttons[data-opt-name="Width"]');
      allSizeOptions.forEach(option => {
        option.checked = false;
        option.removeAttribute('checked');
      });
      
      // Force "PLEASE SELECT SIZE" state
      this.setButtonText('PLEASE SELECT SIZE');
      this.disableButton();
      this.hidePrice();
    }
    
    // Listen for variant changes
    this.attachVariantListeners();
    
    // Listen for product switch events (from color swatch handler)
    document.addEventListener('product:switched', () => {
      setTimeout(() => this.handleProductSwitch(), 100);
    });
  }

  handleProductSwitch() {
    // Re-query buttons after product switch
    this.mainButton = document.querySelector('.product-form__submit');
    this.stickyButton = document.querySelector('.sticky_form__submit');
    
    if (!this.mainButton) return;
    
    this.hasSizeOption = this.mainButton.getAttribute('data-has-size-option') === 'true';
    this.updateButtonState();
    this.attachVariantListeners();
  }

  attachVariantListeners() {
    // Listen to all size/width option changes
    const sizeOptions = document.querySelectorAll('.custom-option-buttons[data-opt-name="Size"], .custom-option-buttons[data-opt-name="Width"]');
    
    sizeOptions.forEach(option => {
      option.addEventListener('change', () => {
        setTimeout(() => this.updateButtonState(), 50);
      });
    });
  }

  updateButtonState() {
    if (!this.hasSizeOption) {
      // No size option, keep default state
      return;
    }

    // Check if a size is selected
    const selectedSize = document.querySelector('.custom-option-buttons[data-opt-name="Size"]:checked, .custom-option-buttons[data-opt-name="Width"]:checked');
    
    if (!selectedSize) {
      // No size selected - show "PLEASE SELECT SIZE"
      this.setButtonText('PLEASE SELECT SIZE');
      this.disableButton();
      this.hidePrice();
    } else {
      // Size selected - check variant availability
      const variantInput = document.querySelector('input[name="id"][type="hidden"]');
      const variantId = variantInput ? variantInput.value : null;
      
      if (variantId) {
        // Fetch variant data to check availability
        this.checkVariantAndUpdateButton(variantId);
      }
    }
  }

  checkVariantAndUpdateButton(variantId) {
    // Get variant data from the page's JSON
    const variantData = this.getVariantData(variantId);
    
    if (variantData) {
      if (variantData.available) {
        this.setButtonText('Add to cart');
        this.enableButton();
        this.showPrice(variantData.price);
      } else {
        this.setButtonText('Sold out');
        this.disableButton();
        this.hidePrice();
      }
    }
  }

  getVariantData(variantId) {
    // Try to get variant data from product JSON script tag
    const productJson = document.querySelector('script[type="application/json"][data-product-json]');
    if (productJson) {
      try {
        const product = JSON.parse(productJson.textContent);
        return product.variants.find(v => v.id == variantId);
      } catch (e) {
        console.error('Error parsing product JSON:', e);
      }
    }
    return null;
  }

  setButtonText(text) {
    console.log('Setting button text to:', text);
    
    if (this.mainButton) {
      const btnText = this.mainButton.querySelector('.btn-text');
      if (btnText) {
        const textSpan = btnText.querySelector('span');
        if (textSpan) {
          console.log('Found main button text span, updating...');
          textSpan.textContent = text;
        } else {
          console.log('No span found in main button, setting directly on .btn-text');
          btnText.textContent = text;
        }
      } else {
        console.log('No .btn-text found in main button');
      }
    }
    
    if (this.stickyButton) {
      const btnText = this.stickyButton.querySelector('.btn-text');
      if (btnText) {
        const textSpan = btnText.querySelector('span.hidden');
        if (textSpan) {
          console.log('Found sticky button text span, updating...');
          textSpan.textContent = text;
        } else {
          // Try without the .hidden class
          const anySpan = btnText.querySelector('span:not([class*="icon"])');
          if (anySpan) {
            console.log('Found sticky button span (no .hidden class), updating...');
            anySpan.textContent = text;
          }
        }
      }
    }
  }

  enableButton() {
    if (this.mainButton) {
      this.mainButton.disabled = false;
      this.mainButton.removeAttribute('disabled');
    }
    
    if (this.stickyButton) {
      this.stickyButton.classList.remove('disabled-btn');
    }
  }

  disableButton() {
    if (this.mainButton) {
      this.mainButton.disabled = true;
      this.mainButton.setAttribute('disabled', 'disabled');
    }
    
    if (this.stickyButton) {
      this.stickyButton.classList.add('disabled-btn');
    }
  }

  showPrice(price) {
    if (this.mainButton) {
      const priceDiv = this.mainButton.querySelector('[id^="BuyButtonPrice-"]');
      if (priceDiv) {
        priceDiv.style.display = 'flex';
        const priceElement = priceDiv.querySelector('product-buy-price');
        if (priceElement && price) {
          priceElement.setAttribute('data-price', price);
          // Format price (assuming Shopify money format)
          const formattedPrice = this.formatMoney(price);
          priceElement.textContent = formattedPrice;
        }
      }
    }
  }

  hidePrice() {
    if (this.mainButton) {
      const priceDiv = this.mainButton.querySelector('[id^="BuyButtonPrice-"]');
      if (priceDiv) {
        priceDiv.style.display = 'none';
      }
    }
  }

  formatMoney(cents) {
    // Simple money formatting - adjust based on your currency settings
    const dollars = (cents / 100).toFixed(2);
    return `$${dollars}`;
  }
}

// Initialize
window.addToCartButtonManager = new AddToCartButtonManager();
