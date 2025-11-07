/**
 * Searchspring CLS Prevention Script
 * Monitors Searchspring content loading and removes skeleton loader
 */

(function() {
  'use strict';

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    const searchspringContent = document.getElementById('searchspring-content');
    const searchspringSidebar = document.getElementById('searchspring-sidebar');
    const searchspringToolbar = document.getElementById('searchspring-toolbar');
    const searchspringSummary = document.getElementById('searchspring-summary');
    
    if (!searchspringContent) return;

    // Create a MutationObserver to watch for Searchspring content injection
    const contentObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.addedNodes.length > 0) {
          // Check if actual Searchspring content has been added
          const hasSearchspringContent = Array.from(mutation.addedNodes).some(node => {
            return node.nodeType === 1 && (
              node.classList?.contains('ss-') || 
              node.querySelector?.('[class*="ss-"]') ||
              node.id?.startsWith('ss-')
            );
          });

          if (hasSearchspringContent) {
            // Mark as loaded and remove skeleton
            document.body.classList.add('searchspring-loaded');
            
            // Remove skeleton after a brief delay to ensure smooth transition
            setTimeout(() => {
              const skeleton = document.querySelector('.ss-collection-skeleton');
              if (skeleton) {
                skeleton.style.opacity = '0';
                skeleton.style.transition = 'opacity 0.3s ease';
                setTimeout(() => skeleton.remove(), 300);
              }
            }, 100);

            // Disconnect observer once content is loaded
            contentObserver.disconnect();
          }
        }
      });
    });

    // Observe the main content container
    contentObserver.observe(searchspringContent, {
      childList: true,
      subtree: true
    });

    // Fallback: Remove skeleton after 5 seconds if Searchspring hasn't loaded
    setTimeout(() => {
      if (!document.body.classList.contains('searchspring-loaded')) {
        console.warn('Searchspring content did not load within 5 seconds');
        const skeleton = document.querySelector('.ss-collection-skeleton');
        if (skeleton) {
          skeleton.style.opacity = '0';
          skeleton.style.transition = 'opacity 0.3s ease';
          setTimeout(() => skeleton.remove(), 300);
        }
        contentObserver.disconnect();
      }
    }, 5000);

    // Also observe sidebar and toolbar for additional loading indicators
    if (searchspringSidebar) {
      const sidebarObserver = new MutationObserver(() => {
        if (searchspringSidebar.children.length > 0) {
          sidebarObserver.disconnect();
        }
      });
      sidebarObserver.observe(searchspringSidebar, { childList: true });
    }

    if (searchspringToolbar) {
      const toolbarObserver = new MutationObserver(() => {
        if (searchspringToolbar.children.length > 0) {
          toolbarObserver.disconnect();
        }
      });
      toolbarObserver.observe(searchspringToolbar, { childList: true });
    }

    // Clean up empty summary container after Searchspring loads
    if (searchspringSummary) {
      const summaryObserver = new MutationObserver(() => {
        // Check if summary is still empty after a delay
        setTimeout(() => {
          if (searchspringSummary.children.length === 0 && 
              searchspringSummary.textContent.trim() === '') {
            searchspringSummary.style.display = 'none';
          }
        }, 1000);
        summaryObserver.disconnect();
      });
      
      // Observe for any changes
      summaryObserver.observe(searchspringSummary, { 
        childList: true, 
        characterData: true, 
        subtree: true 
      });

      // Also check immediately after main content loads
      setTimeout(() => {
        if (document.body.classList.contains('searchspring-loaded') &&
            searchspringSummary.children.length === 0 && 
            searchspringSummary.textContent.trim() === '') {
          searchspringSummary.style.display = 'none';
        }
      }, 2000);
    }
  }

  // Listen for Searchspring custom events if they exist
  window.addEventListener('searchspring.ready', () => {
    document.body.classList.add('searchspring-loaded');
  });

  window.addEventListener('searchspring.results', () => {
    document.body.classList.add('searchspring-loaded');
  });
})();
