// Notification Banner Popup functionality
class NotificationBannerPopup {
    constructor() {
        this.popups = document.querySelectorAll('.notification-banner-popup');
        this.activePopup = null;
        this.isVisible = false;

        if (this.popups.length > 0) {
            this.init();
        }
    }

    init() {
        // Bind event listeners for all popups
        this.bindEvents();

        // Bind click events to announcement slides
        this.bindAnnouncementClicks();
    }

    bindEvents() {
        // Bind events for each popup
        this.popups.forEach(popup => {
            const overlay = popup.querySelector('.notification-banner-overlay');
            const closeBtn = popup.querySelector('.notification-banner-close');

            // Close button click
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.hide();
                });
            }

            // Overlay click to close
            if (overlay) {
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        this.hide();
                    }
                });
            }

            // Prevent body scroll when popup is open
            popup.addEventListener('scroll', (e) => {
                e.stopPropagation();
            });
        });

        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                this.hide();
            }
        });
    }

    bindAnnouncementClicks() {
        // Find all dropdown toggle buttons (now inside announcement content)
        const dropdownToggles = document.querySelectorAll('.announcement-dropdown-toggle');
        
        if (dropdownToggles.length === 0) {
            console.log('No dropdown toggles found');
            return;
        }

        // Find all announcement slides to get the first one with a popup
        const announcementSlides = document.querySelectorAll('.announcement__slide');
        console.log('Found announcement slides:', announcementSlides.length);

        let targetPopup = null;
        
        // Find the first slide with an associated popup
        for (const slide of announcementSlides) {
            const blockId = this.getBlockIdFromSlide(slide);
            console.log('Block ID for slide:', blockId);

            if (blockId) {
                const popup = document.getElementById(`notification-banner-popup-${blockId}`);
                console.log('Found popup for block:', popup);

                if (popup) {
                    targetPopup = popup;
                    break;
                }
            }
        }

        if (!targetPopup) {
            console.log('No popup found for any announcement');
            return;
        }

        // Add click event to all dropdown toggle buttons with toggle functionality
        dropdownToggles.forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('Dropdown toggle clicked!');
                
                // Toggle: if popup is visible, hide it; otherwise show it
                if (this.isVisible && this.activePopup === targetPopup) {
                    this.hide();
                } else {
                    this.showPopup(targetPopup);
                }
            });
        });

        // Add click event to announcement content (but not the toggle button)
        const announcementContents = document.querySelectorAll('.announcement__content');
        announcementContents.forEach(content => {
            content.addEventListener('click', (e) => {
                // Don't trigger if clicking the toggle button itself
                if (e.target.closest('.announcement-dropdown-toggle')) {
                    return;
                }
                e.preventDefault();
                console.log('Announcement content clicked!');
                this.showPopup(targetPopup);
            });
        });
    }

    getBlockIdFromSlide(slide) {
        // Try to find block ID from various possible attributes
        const blockElement = slide.querySelector('[data-block-id]');
        if (blockElement) {
            return blockElement.getAttribute('data-block-id');
        }

        // Try shopify attributes
        const shopifyBlock = slide.querySelector('[shopify-block]');
        if (shopifyBlock) {
            return shopifyBlock.getAttribute('shopify-block');
        }

        // Try data-shopify-editor-block
        const editorBlock = slide.querySelector('[data-shopify-editor-block]');
        if (editorBlock) {
            const blockData = JSON.parse(editorBlock.getAttribute('data-shopify-editor-block') || '{}');
            return blockData.id;
        }

        // Check if the slide itself has the block ID
        if (slide.hasAttribute('data-block-id')) {
            return slide.getAttribute('data-block-id');
        }

        return null;
    }

    showPopup(popup) {
        // Hide any currently active popup first
        if (this.activePopup && this.isVisible) {
            this.hidePopup(this.activePopup);
        }

        this.activePopup = popup;

        popup.style.display = 'block';

        // Force reflow before adding show class for smooth animation
        popup.offsetHeight;

        popup.classList.add('show');
        this.isVisible = true;

        // Update all dropdown toggle aria-expanded states
        const dropdownToggles = document.querySelectorAll('.announcement-dropdown-toggle');
        dropdownToggles.forEach(toggle => {
            toggle.setAttribute('aria-expanded', 'true');
        });

        // Prevent body scroll
        document.body.style.overflow = 'hidden';

        // Dispatch custom event
        document.dispatchEvent(new CustomEvent('notificationBanner:shown', {
            detail: { popup: popup }
        }));
    }

    hide() {
        if (!this.isVisible || !this.activePopup) return;

        this.hidePopup(this.activePopup);
    }

    hidePopup(popup) {
        popup.classList.remove('show');
        this.isVisible = false;

        // Update all dropdown toggle aria-expanded states
        const dropdownToggles = document.querySelectorAll('.announcement-dropdown-toggle');
        dropdownToggles.forEach(toggle => {
            toggle.setAttribute('aria-expanded', 'false');
        });

        // Restore body scroll
        document.body.style.overflow = '';

        // Hide popup after animation completes
        setTimeout(() => {
            if (!this.isVisible) {
                popup.style.display = 'none';
            }
        }, 300);

        // Dispatch custom event
        document.dispatchEvent(new CustomEvent('notificationBanner:hidden', {
            detail: { popup: popup }
        }));

        this.activePopup = null;
    }

    // Public method to manually show popup (for testing or other triggers)
    forceShow(blockId) {
        const popup = blockId ?
            document.getElementById(`notification-banner-popup-${blockId}`) :
            this.popups[0];

        if (popup) {
            this.showPopup(popup);
        }
    }

    // Public method to reset the popup state
    reset() {
        if (this.isVisible) {
            this.hide();
        }
    }
}

// Initialize notification banner popup when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    // Initialize notification banner popup
    window.notificationBannerPopup = new NotificationBannerPopup();
});

// Also initialize if DOM is already loaded (for dynamic content)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        if (!window.notificationBannerPopup) {
            window.notificationBannerPopup = new NotificationBannerPopup();
        }
    });
} else {
    // DOM already loaded
    if (!window.notificationBannerPopup) {
        window.notificationBannerPopup = new NotificationBannerPopup();
    }
}