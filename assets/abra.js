// Cart Auto Add
(() => {
    let pending = false;
    
    window.addEventListener('abra:cart:changed', function(event) {
      if (pending) {
        return;
      }
      
      pending = true;
      
      setTimeout(function() {
        document.dispatchEvent(new CustomEvent('cart:refresh', { detail: { open: false } }));
        
        setTimeout(function() {
          pending = false;
        }, 1000);
      }, 50);
    });
  })();