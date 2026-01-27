// Enhanced JavaScript for Dynamic Feature Section
// This should be included in your main theme JavaScript file
// or added as a separate script in the section

class DynamicFeatureSection {
  constructor(section) {
    this.section = section;
    this.sectionId = section.dataset.sectionId;
    this.isMobile = window.innerWidth <= 768;
    this.resizeObserver = null;
    
    // Get all elements
    this.dots = section.querySelectorAll('.dynamic-feature__dot');
    this.lines = section.querySelectorAll('.dynamic-feature__line');
    this.svg = section.querySelector('.dynamic-feature__lines');
    this.mediaContainer = section.querySelector('.dynamic-feature__media');
    
    this.init();
    this.setupEventListeners();
  }

  init() {
    if (this.isMobile) {
      this.setupMobileInteractions();
    } else {
      this.setupDesktopInteractions();
      this.calculateAndDrawLines();
    }
    
    // Setup resize observer for better responsiveness
    this.observeMediaSize();
  }

  /**
   * Calculate SVG line lengths and set proper styling
   */
  calculateAndDrawLines() {
    if (!this.svg) return;

    // Wait for SVG to be fully rendered
    requestAnimationFrame(() => {
      const svgRect = this.svg.getBoundingClientRect();
      
      this.lines.forEach((line) => {
        try {
          // Get the actual length of the SVG path
          const length = line.getTotalLength();
          
          // Set CSS variable for stroke animation
          line.style.setProperty('--line-length', length.toString());
          
          // Optional: Add data attribute for debugging
          line.setAttribute('data-length', length.toFixed(2));
        } catch (e) {
          console.warn('Could not calculate line length:', e);
          // Fallback: use a reasonable default
          line.style.setProperty('--line-length', '300');
        }
      });
    });
  }

  /**
   * Setup mobile-specific interactions
   */
  setupMobileInteractions() {
    this.dots.forEach((dot) => {
      dot.style.cursor = 'pointer';
      
      // Add visual feedback
      dot.addEventListener('touchstart', () => {
        dot.classList.add('is-active');
        dot.style.transform = 'scale(1.2)';
      });
      
      dot.addEventListener('touchend', () => {
        dot.classList.remove('is-active');
        dot.style.transform = '';
      });
      
      // Click handler for opening modal
      dot.addEventListener('click', (e) => this.handleDotClick(e));
    });
  }

  /**
   * Setup desktop-specific interactions
   */
  setupDesktopInteractions() {
    this.dots.forEach((dot) => {
      dot.style.cursor = 'pointer';
      
      // Subtle hover effect
      dot.addEventListener('mouseenter', () => {
        dot.classList.add('is-hovered');
      });
      
      dot.addEventListener('mouseleave', () => {
        dot.classList.remove('is-hovered');
      });
      
      // Click handler (for future expansion)
      dot.addEventListener('click', (e) => {
        // Could open modal or trigger animation
      });
    });
  }

  /**
   * Handle dot clicks - open modal on mobile
   */
  handleDotClick(e) {
    const blockId = e.currentTarget.id;
    const sectionId = this.section.dataset.sectionId;
    const realBlockId = blockId.replace('shopify-block-', '');
    const modalId = `Feature-${sectionId}-${realBlockId}`;
    
    const modal = document.getElementById(modalId);
    if (modal && typeof modal.open === 'function') {
      modal.open();
    }
  }

  /**
   * Observe media container size changes and recalculate lines
   */
  observeMediaSize() {
    if ('ResizeObserver' in window && this.mediaContainer) {
      this.resizeObserver = new ResizeObserver(() => {
        // Only recalculate if not mobile
        if (!this.isMobile) {
          this.calculateAndDrawLines();
        }
      });
      
      this.resizeObserver.observe(this.mediaContainer);
    }
  }

  /**
   * Setup global event listeners
   */
  setupEventListeners() {
    // Handle window resize
    window.addEventListener('resize', () => this.handleResize());
    
    // Handle orientation change (mobile)
    window.addEventListener('orientationchange', () => this.handleResize());
  }

  /**
   * Handle window resize event
   */
  handleResize() {
    const wasMobile = this.isMobile;
    this.isMobile = window.innerWidth <= 768;

    // If mobile state changed, reinitialize
    if (wasMobile !== this.isMobile) {
      this.init();
    } else if (!this.isMobile) {
      // Still desktop, but size changed - recalculate lines
      this.calculateAndDrawLines();
    }
  }

  /**
   * Destroy the section instance
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.dots.forEach(dot => {
      dot.removeEventListener('click', this.handleDotClick);
      dot.removeEventListener('touchstart', null);
      dot.removeEventListener('touchend', null);
      dot.removeEventListener('mouseenter', null);
      dot.removeEventListener('mouseleave', null);
    });
  }
}

// Initialize sections
(function() {
  const initializeSections = () => {
    document.querySelectorAll('[data-section-id]').forEach(section => {
      if (!section.dataset.dynamicFeatureInitialized) {
        new DynamicFeatureSection(section);
        section.dataset.dynamicFeatureInitialized = 'true';
      }
    });
  };

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSections);
  } else {
    initializeSections();
  }

  // Reinitialize on Shopify section load
  document.addEventListener('shopify:section:load', (e) => {
    const section = e.detail.section;
    if (section.querySelector('.dynamic-feature')) {
      new DynamicFeatureSection(section);
    }
  });

  // Cleanup on section unload
  document.addEventListener('shopify:section:unload', (e) => {
    const section = e.detail.section;
    const instance = section.dynamicFeatureInstance;
    if (instance) {
      instance.destroy();
      delete section.dynamicFeatureInstance;
    }
  });
})();