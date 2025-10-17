

const stickyATCBtn = document.querySelector("#custom-sticky-cart-btn");
if(stickyATCBtn){
stickyATCBtn.addEventListener("click", function (e) {
  if (stickyATCBtn.classList.contains("disabled-btn")) {
    e.preventDefault();
    const scrollTarget = document.querySelector(".custom-main-product");
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ behavior: "smooth" });
    }
  }
});
}

function refreshAddToCartButton() {
  const submitBtn = document.querySelector(".product-form__submit");
  const stickyBtn = document.querySelector(".sticky_form__submit");
  if (!submitBtn || !stickyBtn) return;

  // Fetch current page content
  fetch(window.location.href)
    .then(res => res.text())
    .then(html => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const newSubmitBtn = doc.querySelector(".product-form__submit");
      const newStickyBtn = doc.querySelector(".sticky_form__submit");
      
      if (newSubmitBtn || newStickyBtn) {
        submitBtn.innerHTML = newSubmitBtn.innerHTML;
        submitBtn.className = newSubmitBtn.className; // In case classes change
        submitBtn.disabled = newSubmitBtn.disabled;   // Sync disabled state
        submitBtn.setAttribute('type', newSubmitBtn.getAttribute('type')); // Sync type

        stickyBtn.innerHTML = newSubmitBtn.innerHTML;
        stickyBtn.className = newSubmitBtn.className; // In case classes change
        stickyBtn.disabled = newSubmitBtn.disabled;   // Sync disabled state
        stickyBtn.setAttribute('type', newSubmitBtn.getAttribute('type')); // Sync type
        // You can add more attributes here if needed
      }
    })
    .catch(err => {
      console.error("Failed to reload add-to-cart button:", err);
    });
}

function resetVariantsAndDisableButton() {
  const variantOptButtons = document.querySelectorAll(".custom-option-buttons");
  const addTocartBtn = document.querySelector("button.product-form__submit");
  const stickyAddTocartBtn = document.querySelector("button.sticky_form__submit");

  variantOptButtons.forEach((optBtn) => {
    const optName = optBtn.getAttribute("data-opt-name");
    
    if (optName === "Size" || optName === "Width") {
      // Properly reset the checked state
      optBtn.removeAttribute("checked");
      optBtn.checked = false;
      
      // Remove any active/selected classes that might be applied
      optBtn.classList.remove('selected', 'active', 'checked');
      
      if (addTocartBtn) {
        addTocartBtn.style.display = "flex";
        addTocartBtn.setAttribute("disabled", "disabled");
        addTocartBtn.disabled = true;

        // Update .btn-text if it exists, otherwise set directly on button
        const btnText = addTocartBtn.querySelector('.btn-text');
        if (btnText) {
          btnText.innerText = "PLEASE SELECT " + optName.toUpperCase();
        } else {
          addTocartBtn.innerText = "PLEASE SELECT " + optName.toUpperCase();
        }
      }

      if (stickyAddTocartBtn) {
        stickyAddTocartBtn.style.display = "flex";
        stickyAddTocartBtn.classList.add("disabled-btn");
        stickyAddTocartBtn.setAttribute("disabled", "disabled");
        stickyAddTocartBtn.disabled = true;

        // Update .btn-text if it exists, otherwise set directly on button
        const btnText = stickyAddTocartBtn.querySelector('.btn-text');
        if (btnText) {
          btnText.innerText = "PLEASE SELECT " + optName.toUpperCase();
        } else {
          stickyAddTocartBtn.innerText = "PLEASE SELECT " + optName.toUpperCase();
        }
      }
    }
  });
  
  // Reattach event listeners after reset
  attachVariantEventListeners();
}

function attachVariantEventListeners() {
  const variantOptButtons = document.querySelectorAll(".custom-option-buttons");
  
  variantOptButtons.forEach((optBtn) => {
    const optName = optBtn.getAttribute("data-opt-name");
    
    // Remove existing listeners to prevent duplicates
    if (optBtn._clickHandler) {
      optBtn.removeEventListener("click", optBtn._clickHandler);
    }
    if (optBtn._changeHandler) {
      optBtn.removeEventListener("change", optBtn._changeHandler);
    }
    
    // Create and store click handler
    optBtn._clickHandler = (event) => {
      if (optBtn.classList.contains("disabled")) {
        return;
      }
      
      // Ensure the button is checked and has active state
      optBtn.checked = true;
      optBtn.setAttribute("checked", "checked");
      
      // Remove checked state from other buttons in the same option group
      const sameOptionButtons = document.querySelectorAll(`.custom-option-buttons[data-opt-name="${optName}"]`);
      sameOptionButtons.forEach((btn) => {
        if (btn !== optBtn) {
          btn.checked = false;
          btn.removeAttribute("checked");
        }
      });
    };
    
    // Create and store change handler
    optBtn._changeHandler = (event) => {
      if (optBtn.classList.contains("disabled")) {
        console.log("This option is disabled. Skipping update.");
        return;
      }
      console.log(optBtn);
      
      // Ensure the button is checked and has active state
      optBtn.checked = true;
      optBtn.setAttribute("checked", "checked");
      
      if (["Size", "Width", "Color"].includes(optName)) {
        refreshAddToCartButton();
      }
    };
    
    // Attach the handlers
    optBtn.addEventListener("click", optBtn._clickHandler);
    optBtn.addEventListener("change", optBtn._changeHandler);
  });
}

// === Variant Button Handling ===
// Initialize variant buttons on page load
(function initializeVariantButtons() {
  const variantOptButtons = document.querySelectorAll(".custom-option-buttons");
  const addTocartBtn = document.querySelector("button.product-form__submit");
  const stickyAddTocartBtn = document.querySelector("button.sticky_form__submit");

  variantOptButtons.forEach((optBtn) => {
    const optName = optBtn.getAttribute("data-opt-name");
    console.log(optName,"optName");
    
    if (optName === "Size" || optName === "Width") {
      optBtn.removeAttribute("checked");
      if (addTocartBtn) {
        addTocartBtn.style.display = "flex";
        addTocartBtn.setAttribute("disabled", "disabled");

        // Update .btn-text if it exists, otherwise set directly on button
        const btnText = addTocartBtn.querySelector('.btn-text');
        if (btnText) {
          btnText.innerText = "PLEASE SELECT " + optName.toUpperCase();
        } else {
          addTocartBtn.innerText = "PLEASE SELECT " + optName.toUpperCase();
        }
      }

      if (stickyAddTocartBtn) {
        stickyAddTocartBtn.style.display = "flex";
        stickyAddTocartBtn.classList.add("disabled-btn");

        // Update .btn-text if it exists, otherwise set directly on button
        const btnText = stickyAddTocartBtn.querySelector('.btn-text');
        if (btnText) {
          btnText.innerText = "PLEASE SELECT " + optName.toUpperCase();
        } else {
          stickyAddTocartBtn.innerText = "PLEASE SELECT " + optName.toUpperCase();
        }
      }
    }
  });
  
  // Attach event listeners
  attachVariantEventListeners();
})();


document.addEventListener("DOMContentLoaded", function () {

  // Listen for product switch events and reset variants
  document.addEventListener('product:switched', function(event) {
    console.log('Product switched, resetting variants:', event.detail);
    // Small delay to ensure DOM is updated
    setTimeout(() => {
      resetVariantsAndDisableButton();
    }, 100);
  });

  //
  const dropDownArw = document.querySelectorAll("span.promo-banner__caret");
  const dropDownDiv = document.querySelectorAll(".promo-banner__dropdown");
  const dropDownClose = document.querySelectorAll(".promo-banner__dropdown-close");
  
  dropDownArw.forEach((arrw) => {
    arrw.addEventListener("click", function (e) {
      dropDownDiv.forEach((dropdiv) => {
        dropdiv.classList.toggle("active-drop-div");
      })
      arrw.classList.toggle("active-dropdown");
    });
  });

  dropDownClose.forEach((closeBtn) => {
    closeBtn.addEventListener("click", function (e) {
      dropDownArw.forEach((arrw) => {
        if(arrw.classList.contains("active-dropdown")){
         arrw.classList.remove("active-dropdown");
        }
      })
      dropDownDiv.forEach((dropdiv) => {
        if(dropdiv.classList.contains("active-drop-div")){
          dropdiv.classList.remove("active-drop-div");
        }
      })
    })
  })
  //

  
  // custom video popup starts
  const triggerBtn = document.querySelectorAll(".video-play-button");
  const modal = document.getElementById("videoModal");
  const video = document.getElementById("popupVideo");
  const closeBtn = document.getElementById("closeBtn");

  if(triggerBtn){
    triggerBtn.forEach((playbtn) => {
      playbtn.addEventListener("click", function (e) {
        e.preventDefault();
        const videoUrl = this.getAttribute("data-url");
        video.src = videoUrl;
        video.play().catch(() => {
          console.warn("Autoplay failed. User gesture may be required.");
        });
        modal.classList.add("active");
      });
    });

    if(closeBtn){
      closeBtn.addEventListener("click", function () {
        console.log(modal,"modal")
        modal.classList.remove("active");
        video.pause();
        video.currentTime = 0;
        video.src = "";
      });
    }

    if(modal){
      modal.addEventListener("click", function (e) {
        if (e.target === modal) {
          video.pause();
          video.currentTime = 0;
          video.src = "";
          modal.classList.remove("active");
        }
      });
    }
  }
  // custom video popup ends

  
});



// custom detect symbols of tradmark and register starts
function separateTrademarkSymbols() {
  // Only target specific content areas where trademark symbols should appear
  const contentSelectors = [
    '.rte',
    '.product-description', 
    '.specification',
    '.product-content',
    '.content-area',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p:not([class*="price"]):not([class*="field"]):not([class*="input"])',
    'li:not([class*="price"]):not([class*="field"]):not([class*="input"])',
    'td:not([class*="price"]):not([class*="field"]):not([class*="input"])',
    'th:not([class*="price"]):not([class*="field"]):not([class*="input"])',
    'figcaption',
    'caption',
    'blockquote'
  ];

  const elements = document.querySelectorAll(contentSelectors.join(', '));

  elements.forEach(el => {
    // Skip any elements that are inside or part of form/interactive components
    if (el.closest('form, price-range, facet-filters, .facets, .filter, .field, .input-wrapper, .range-wrapper, .price-range, input, select, textarea, button, [class*="facet"], [class*="filter"], [class*="range"], [data-price]')) {
      return;
    }
    
    // Additional check: skip if element has form-related classes
    const classList = el.className || '';
    if (classList.includes('prefix') || classList.includes('field') || classList.includes('input') || classList.includes('range') || classList.includes('filter') || classList.includes('facet')) {
      return;
    }
    
    // Get the original HTML content
    let originalHTML = el.innerHTML;
    
    // Find all trademark symbols in the HTML and wrap them
    // This regex finds trademark symbols that are not already wrapped in spans and not inside HTML attributes/URLs
    const symbolRegex = /(?<!<span[^>]*>)(?<!href="[^"]*?)(?<!src="[^"]*?)(?<!data-[^=]*="[^"]*?)([®™]|(?<![a-z])TM(?![a-z]))(?![^<]*<\/span>)(?![^"]*"[^>]*>)/gi;
    
    // Check if there are any trademark symbols to process
    if (symbolRegex.test(originalHTML)) {
      // Reset regex lastIndex for global regex
      symbolRegex.lastIndex = 0;
      
      // Replace all found symbols with wrapped versions
      const newHTML = originalHTML.replace(symbolRegex, (match, symbol) => {
        // Determine class based on symbol
        const className = symbol === '®' ? 'register-symbol' : 'trademark-symbol';
        return `<span class="${className}">${symbol}</span>`;
      });
      
      el.innerHTML = newHTML;
    }
  });
}

document.addEventListener("DOMContentLoaded", separateTrademarkSymbols);
// custom detect symbols of tradmark and register end


// custom PLP swatch slider start //
function initSwatchSlider() {
  // 1. Store all Swiper instances by DOM element
  const sliderMap = new Map();

  // 2. Init all media sliders separately
  document.querySelectorAll('.main-media-custom-slider').forEach((el) => {
    const swiperInstance = new Swiper(el, {
      slidesPerView: 1,
      centeredSlides: true,
      allowTouchMove: false,
      effect: "fade",
    });
    sliderMap.set(el, swiperInstance);
  });

  // 3. Init swatch sliders
  const Swatchswiper = new Swiper('.main-swatch-custom-slider', {
    slidesPerView: 'auto',
    loop: false,
    allowTouchMove: true, 
    draggable: true,
    observer: true,
    navigation: {
      nextEl: '.swiper-button-next',
      prevEl: '.swiper-button-prev',
    },
    breakpoints: {
        0: {
          spaceBetween: 7,
        },
        481: {
          spaceBetween: 10,
        },
    },
  });


  // 4. Mouseover handler for swatches
  document.querySelectorAll('.custom-color-swatch-link').forEach((swatch) => {
    const handleSwatchInteraction = function () {
      const swatchID = this.getAttribute('data-img-id');
      const content = this.closest('.product-card__content');
      const dataVariantBadge = this.getAttribute('data-variant-badge');
      const displayBadge = dataVariantBadge ? dataVariantBadge.replace(/-/g, ' ') : '';
      
      if (!content) return;

      const swatchParent = this.closest('.product-variant-slider-wrapper')?.previousElementSibling;
      const swatchParentLink = swatchParent ? swatchParent.querySelectorAll('a.product-card__title') : [];
      const swatchMainPrice =  swatchParent ? swatchParent.querySelectorAll('div.price.flex > span.price__regular') : [];
      const swatchSalePrice =  swatchParent ? swatchParent.querySelectorAll('div.price.flex > span.price__sale') : [];
      // console.log(swatchMainPrice,"swatchPriceDiv", swatchSalePrice);

      const dataVariantMainPrice = this.getAttribute('data-compare-price');
      const MainpriceNumber = parseFloat(dataVariantMainPrice.replace(/[^\d.]/g, ""));
      
      const dataVariantSalePrice = this.getAttribute('data-sale-price');
      const SalepriceNumber = parseFloat(dataVariantSalePrice.replace(/[^\d.]/g, ""));
    
      const imageParent = content.previousElementSibling;
      if (!imageParent) return;

      const swiperSlides = imageParent.querySelectorAll('.swiper-slide');
      const currentSwiper = sliderMap.get(imageParent.querySelector('.main-media-custom-slider'));
      if (!currentSwiper) return;

      const allSwatches = content.querySelectorAll('.custom-color-swatch-link');
      allSwatches.forEach(s => s.classList.remove('matched-swatch'));
      this.classList.add('matched-swatch');

      swiperSlides.forEach((slide) => {
        const slideID = slide.getAttribute('data-img-id');
        const slideURL = slide.getAttribute('data-prod-url');
        const slideIndex = parseInt(slide.getAttribute('data-index'), 10) - 1;
        const slideAnchorTag = imageParent.querySelectorAll('a.custom-product-url');
        const slideBadgeTag = imageParent.querySelectorAll('div.badges > span.custom-product-badges ');
        
        if (slideID === swatchID) {
          setTimeout(() => {
          if (dataVariantBadge.length > 0) {
            slideBadgeTag.forEach(badge => {
              // Remove any previously added custom-variant-badge-* classes
              badge.classList.forEach(cls => {
                if (cls.startsWith('custom-variant-badge')) {
                  badge.classList.remove("hidden");
                  badge.classList.remove(cls);
                }
              });

              // Add the new class
              badge.classList.add("custom-variant-badge-" + dataVariantBadge);
              badge.innerText = displayBadge;
                // if(swatchMainPrice.length > 0 || MainpriceNumber > 0 || swatchSalePrice.length > 0 || SalepriceNumber > 0){
                  
                //   swatchMainPrice.innerText = dataVariantMainPrice;
                //   swatchSalePrice.innerText = dataVariantSalePrice;
                // }

              // Update Price Structure
                if (swatchParent) {
                  const priceWrapper = swatchParent.querySelector('.price');
                  if (priceWrapper) {
                    let regularSpan = priceWrapper.querySelector('.price__regular');
                    let saleSpan = priceWrapper.querySelector('.price__sale');
                
                    if (!regularSpan) {
                      regularSpan = document.createElement('span');
                      regularSpan.className = 'price__regular whitespace-nowrap';
                      priceWrapper.appendChild(regularSpan);
                    }
                
                    if (!saleSpan) {
                      saleSpan = document.createElement('span');
                      saleSpan.className = 'price__sale inline-flex items-center h-auto relative';
                      priceWrapper.appendChild(saleSpan);
                    }
                
                    // Flip logic if main > sale
                    if (MainpriceNumber > 0 && SalepriceNumber > 0) {
                      if (MainpriceNumber > SalepriceNumber) {
                        // Put smaller (sale) in regular, bigger (compare-at) in sale
                        priceWrapper.classList.add("price--on-sale");
                        regularSpan.innerText = dataVariantSalePrice;
                        saleSpan.innerText =  dataVariantMainPrice;
                        regularSpan.style.display = '';
                        saleSpan.style.display = '';
                      } else {
                        // Normal order
                        priceWrapper.classList.add("price--on-sale");
                        regularSpan.innerText = dataVariantSalePrice;
                        saleSpan.innerText = dataVariantMainPrice;
                        regularSpan.style.display = '';
                        saleSpan.style.display = '';
                      }
                    } else if (MainpriceNumber > 0) {
                      priceWrapper.classList.remove("price--on-sale");
                      regularSpan.innerText = dataVariantMainPrice;
                      saleSpan.style.display = 'none';
                    } else if (SalepriceNumber > 0) {
                      priceWrapper.classList.remove("price--on-sale");
                      regularSpan.innerText = dataVariantSalePrice;
                      saleSpan.style.display = 'none';
                    } else {
                      // If both are zero or missing, hide both
                      priceWrapper.classList.remove("price--on-sale");
                      regularSpan.style.display = 'none';
                      saleSpan.style.display = 'none';
                    }
                  }
                }

            });
          } else {
            slideBadgeTag.forEach(badge => {
              badge.classList.add("hidden");
            });
          }

            slideAnchorTag.forEach(anchor => anchor.setAttribute('href', slideURL));
            swatchParentLink.forEach(anchor => anchor.setAttribute('href', slideURL));
            currentSwiper.slideTo(slideIndex);
          }, 200);
        }
      });
    };

    // Desktop hover
    swatch.addEventListener('mouseover', handleSwatchInteraction);

    // Mobile tap
    swatch.addEventListener('touchstart', handleSwatchInteraction, { passive: true });

    // Optional: Pointer event fallback (covers stylus or hybrid devices)
    swatch.addEventListener('pointerenter', handleSwatchInteraction);
  });


  // 5. Reset on mouseleave
  // document.querySelectorAll('.custom-product-card').forEach((content) => {
  //   content.addEventListener('mouseleave', function () {
  //     const imageParent = content.closest('.product-card').querySelector('.product-card__media');
  //     if (!imageParent) return;

  //     const swiperEl = imageParent.querySelector('.main-media-custom-slider');
  //     const currentSwiper = sliderMap.get(swiperEl);
  //     if (!currentSwiper) return;

  //     const swatches = content.querySelectorAll('.custom-color-swatch-link');
  //     swatches.forEach(s => s.classList.remove('matched-swatch'));

  //     if (swatches.length > 0) {
  //       const firstSwatch = swatches[0];
  //       firstSwatch.classList.add('matched-swatch');

  //       const swatchID = firstSwatch.getAttribute('data-img-id');
  //       const dataVariantBadge = firstSwatch.getAttribute('data-variant-badge');
  //       const displayBadge = dataVariantBadge ? dataVariantBadge.replace(/-/g, ' ') : '';

  //       const swiperSlides = imageParent.querySelectorAll('.swiper-slide');
  //       const slideAnchorTags = imageParent.querySelectorAll('a.custom-product-url');
  //       const badgeTags = imageParent.querySelectorAll('div.badges > span.custom-product-badges');

  //       let matchingSlide = null;

  //       swiperSlides.forEach((slide) => { 
  //         if (slide.getAttribute('data-img-id') === swatchID) {
  //           matchingSlide = slide;
  //         }
  //       });

  //       if (matchingSlide) {
  //         const slideURL = matchingSlide.getAttribute('data-prod-url');
  //         const slideIndex = parseInt(matchingSlide.getAttribute('data-index'), 10) - 1;

  //         // Set Swiper slide
  //         currentSwiper.slideTo(slideIndex);

  //         // Update hrefs
  //         slideAnchorTags.forEach(anchor => anchor.setAttribute('href', slideURL));

  //         const titleAnchors = content.closest('.product-card').querySelectorAll('a.product-card__title');
  //         titleAnchors.forEach(anchor => anchor.setAttribute('href', slideURL));
  //         // Set the badge (remove old badge classes first)
  //         if (dataVariantBadge) {
  //           badgeTags.forEach(badge => {
  //             badge.classList.forEach(cls => {
  //               if (cls.startsWith('custom-variant-badge')) {
  //                 badge.classList.remove(cls);
  //               }
  //             });
  //             badge.innerText = displayBadge;
  //             badge.classList.add("custom-variant-badge-" + dataVariantBadge);
  //           });
  //         }

  //             // Reset the price based on first swatch
  //             const swatchParent = content.closest('.product-card').querySelector('.product-card__info-wrapper') || content.closest('.product-card');
  //             const priceWrapper = swatchParent.querySelector('.price');
        
  //             if (priceWrapper) {
  //               let regularSpan = priceWrapper.querySelector('.price__regular');
  //               let saleSpan = priceWrapper.querySelector('.price__sale');
        
  //               if (!regularSpan) {
  //                 regularSpan = document.createElement('span');
  //                 regularSpan.className = 'price__regular whitespace-nowrap';
  //                 priceWrapper.appendChild(regularSpan);
  //               }
        
  //               if (!saleSpan) {
  //                 saleSpan = document.createElement('span');
  //                 saleSpan.className = 'price__sale inline-flex items-center h-auto relative';
  //                 priceWrapper.appendChild(saleSpan);
  //               }
        
  //               const rawCompare = firstSwatch.getAttribute('data-compare-price') || '';
  //               const rawSale = firstSwatch.getAttribute('data-sale-price') || '';
  //               const mainPrice = parseFloat(rawCompare.replace(/[^\d.]/g, "")) || 0;
  //               const salePrice = parseFloat(rawSale.replace(/[^\d.]/g, "")) || 0;
        
  //               if (mainPrice > 0 && salePrice > 0) {
  //                 if (mainPrice > salePrice) {
  //                   priceWrapper.classList.add("price--on-sale");
  //                   regularSpan.innerText = rawSale;
  //                   saleSpan.innerText = rawCompare;
  //                   regularSpan.style.display = '';
  //                   saleSpan.style.display = '';
  //                 } else {
  //                   priceWrapper.classList.add("price--on-sale");
  //                   regularSpan.innerText = rawSale;
  //                   saleSpan.innerText = rawCompare;
  //                   regularSpan.style.display = '';
  //                   saleSpan.style.display = '';
  //                 }
  //               } else if (mainPrice > 0) {
  //                 priceWrapper.classList.remove("price--on-sale");
  //                 regularSpan.innerText = rawCompare;
  //                 saleSpan.style.display = 'none';
  //               } else if (salePrice > 0) {
  //                 priceWrapper.classList.remove("price--on-sale");
  //                 regularSpan.innerText = rawSale;
  //                 saleSpan.style.display = 'none';
  //               } else {
  //                 priceWrapper.classList.remove("price--on-sale");
  //                 regularSpan.style.display = 'none';
  //                 saleSpan.style.display = 'none';
  //               }
  //             }
          
  //       }
  //     } else {
  //       // No swatches: reset Swiper to first slide only
  //       currentSwiper.slideTo(0);
  //     }
  //   });
  // });
}
document.addEventListener("DOMContentLoaded", function () { initSwatchSlider()});
// custom PLP swatch slider end //