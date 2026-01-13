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
    
    // Set initial state immediately
    if (this.hasSizeOption) {
      // Check if a size is already selected
      const selectedSize = document.querySelector('.custom-option-buttons[data-opt-name="Size"]:checked, .custom-option-buttons[data-opt-name="Width"]:checked');
      
      // On initial page load, force uncheck all sizes and show "PLEASE SELECT SIZE"
      const allSizeOptions = document.querySelectorAll('.custom-option-buttons[data-opt-name="Size"], .custom-option-buttons[data-opt-name="Width"]');
      allSizeOptions.forEach(option => {
        option.checked = false;
        option.removeAttribute('checked');
        
        // Remove checked class from the label
        const label = option.nextElementSibling;
        if (label && label.classList.contains('label-swatch')) {
          label.classList.remove('checked');
        }
        
        // Also try to find label by for attribute
        const labelById = document.querySelector(`label[for="${option.id}"]`);
        if (labelById) {
          labelById.classList.remove('checked');
        }
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
    
    // Reset state like on initial page load
    if (this.hasSizeOption) {
      // Uncheck all size options
      const allSizeOptions = document.querySelectorAll('.custom-option-buttons[data-opt-name="Size"], .custom-option-buttons[data-opt-name="Width"]');
      allSizeOptions.forEach(option => {
        option.checked = false;
        option.removeAttribute('checked');
        
        // Remove checked class from the label
        const label = option.nextElementSibling;
        if (label && label.classList.contains('label-swatch')) {
          label.classList.remove('checked');
        }
        
        const labelById = document.querySelector(`label[for="${option.id}"]`);
        if (labelById) {
          labelById.classList.remove('checked');
        }
      });
      
      // Force "PLEASE SELECT SIZE" state
      this.setButtonText('PLEASE SELECT SIZE');
      this.disableButton();
      this.hidePrice();
    } else {
      // No size option, show default state
      this.updateButtonState();
    }
    
    // Re-attach variant listeners
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
        this.setButtonText('Add to Cart');
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
        // Error parsing product JSON
      }
    }
    return null;
  }

  setButtonText(text) {
    if (this.mainButton) {
      const btnText = this.mainButton.querySelector('.btn-text');
      if (btnText) {
        let textSpan = btnText.querySelector('span:first-child');
        if (textSpan) {
          textSpan.textContent = text;
        } else {
          // Remove all text nodes
          Array.from(btnText.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
              node.remove();
            }
          });
          
          textSpan = document.createElement('span');
          textSpan.textContent = text;
          // Insert at the beginning, before price div
          btnText.insertBefore(textSpan, btnText.firstChild);
        }
      }
    }
    
    if (this.stickyButton) {
      const btnText = this.stickyButton.querySelector('.btn-text');
      if (btnText) {
        const textSpan = btnText.querySelector('span.hidden');
        if (textSpan) {
          textSpan.textContent = text;
        } else {
          // Try without the .hidden class
          const anySpan = btnText.querySelector('span:not([class*="icon"])');
          if (anySpan) {
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
      const btnText = this.mainButton.querySelector('.btn-text');
      if (!btnText) return;
      
      // Look for any price div (with or without ID)
      let priceDiv = btnText.querySelector('[id^="BuyButtonPrice-"]') || btnText.querySelector('div.flex');
      
      if (!priceDiv) {
        // Create price div if it doesn't exist
        priceDiv = document.createElement('div');
        priceDiv.className = 'flex';
        priceDiv.style.display = 'flex';
        
        const separator = document.createElement('span');
        separator.className = 'relative';
        separator.innerHTML = '&nbsp;&nbsp;-&nbsp;&nbsp;';
        
        const priceElement = document.createElement('product-buy-price');
        priceElement.className = 'price';
        
        priceDiv.appendChild(separator);
        priceDiv.appendChild(priceElement);
        btnText.appendChild(priceDiv);
      } else {
        // Remove any duplicate price divs
        const allPriceDivs = btnText.querySelectorAll('div.flex');
        if (allPriceDivs.length > 1) {
          allPriceDivs.forEach((div, index) => {
            if (index > 0) {
              div.remove();
            }
          });
        }
        priceDiv.style.display = 'flex';
      }
      
      const priceElement = priceDiv.querySelector('product-buy-price');
      
      if (priceElement && price) {
        priceElement.setAttribute('data-price', price);
        // Format price (assuming Shopify money format)
        const formattedPrice = this.formatMoney(price);
        priceElement.textContent = formattedPrice;
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
