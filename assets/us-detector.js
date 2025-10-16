/**
 * Global US User Detection Utility
 * Hides elements with data-us-only attribute for non-US users
 * Integrates with country selector to show/hide content when country changes
 */

(function() {
  'use strict';

  // Check if selected country is US (from country selector or Shopify settings)
  function isSelectedCountryUS() {
    return window.Shopify?.country === 'US';
  }

  // Global function to detect US users via IP/location
  window.detectUSUser = async function() {
    // First check if user manually selected US via country selector
    if (isSelectedCountryUS()) {
      return true;
    }

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

  // Listen for country selector form submissions
  function observeCountryChange() {
    const localizationForms = document.querySelectorAll('localization-form form');

    localizationForms.forEach(form => {
      form.addEventListener('submit', function(e) {
        const countryInput = form.querySelector('input[name="country_code"]');
        if (countryInput) {
          const selectedCountry = countryInput.value;

          sessionStorage.setItem('selectedCountry', selectedCountry);
        }
      });
    });
  }

  // Auto-initialize on DOM ready for elements with data-us-only attribute
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.applyUSShowOnly();
      observeCountryChange();
    });
  } else {
    window.applyUSShowOnly();
    observeCountryChange();
  }
})();
