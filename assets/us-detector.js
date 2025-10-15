/**
 * Global US User Detection Utility
 * Hides elements with data-us-only attribute for non-US users
 */

(function() {
  'use strict';

  // Global function to detect US users
  window.detectUSUser = async function() {
    try {
      const response = await fetch(
        window.Shopify.routes.root
          + 'browsing_context_suggestions.json'
          + '?country[enabled]=true'
          + `&country[exclude]=${window.Shopify.country}`
          + '&language[enabled]=true'
          + `&language[exclude]=${window.Shopify.language}`
      );

      const data = await response.json();
      const detectedCountry = data.detected_values?.country?.handle;

      return detectedCountry === 'US';
    } catch (error) {
      console.error('Error detecting US user:', error);
      return false;
    }
  };

  // Global function to handle US-only elements
  window.applyUSShowOnly = async function(selector = '[data-us-only]') {
    const isUS = await window.detectUSUser();
    const elements = document.querySelectorAll(selector);

    elements.forEach(element => {
      if (isUS) {
        element.removeAttribute('data-us-only');
      }
    });

    return isUS;
  };

  // Auto-initialize on DOM ready for elements with data-us-only attribute
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.applyUSShowOnly();
    });
  } else {
    window.applyUSShowOnly();
  }
})();
