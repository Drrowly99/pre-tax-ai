/**
 * Landing Page interactions for MessyTax index.html
 */

document.addEventListener('DOMContentLoaded', () => {

  // 1. Sticky / Blur Navbar
  const navbar = document.getElementById('navbar');
  const navBrand = document.getElementById('nav-brand');
  const navLinks = document.querySelectorAll('.nav-link:not(.btn)');
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  
  if (navbar) {
      window.addEventListener('scroll', () => {
          if (window.scrollY > 50) {
              navbar.classList.add('nav-blur', 'shadow-sm', 'py-0');
              navBrand.classList.replace('text-white', 'text-gray-900');
              navLinks.forEach(l => {
                  l.classList.replace('text-gray-300', 'text-gray-600');
                  l.classList.replace('hover:text-white', 'hover:text-tax-green');
              });
              mobileMenuBtn.classList.replace('text-white', 'text-gray-900');
          } else {
              navbar.classList.remove('nav-blur', 'shadow-sm', 'py-0');
              navBrand.classList.replace('text-gray-900', 'text-white');
              navLinks.forEach(l => {
                  l.classList.replace('text-gray-600', 'text-gray-300');
                  l.classList.replace('hover:text-tax-green', 'hover:text-white');
              });
              mobileMenuBtn.classList.replace('text-gray-900', 'text-white');
          }
      });
  }

  // 2. Mobile Sidebar
  const mobileSidebar = document.getElementById('mobile-sidebar');
  const mobileOverlay = document.getElementById('mobile-sidebar-overlay');
  const closeBtn = document.getElementById('mobile-close-btn');
  const mobileActiveLinks = document.querySelectorAll('.mobile-link');

  const toggleSidebar = (show) => {
      if (show) {
          mobileSidebar.classList.remove('translate-x-full');
          mobileOverlay.classList.remove('opacity-0', 'pointer-events-none');
      } else {
          mobileSidebar.classList.add('translate-x-full');
          mobileOverlay.classList.add('opacity-0', 'pointer-events-none');
      }
  };

  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => toggleSidebar(true));
  if (closeBtn) closeBtn.addEventListener('click', () => toggleSidebar(false));
  if (mobileOverlay) mobileOverlay.addEventListener('click', () => toggleSidebar(false));
  mobileActiveLinks.forEach(l => l.addEventListener('click', () => toggleSidebar(false)));

  // 3. Scroll Intersection Observer (Fade Up Animations)
  const fadeElements = document.querySelectorAll('.fade-up');
  
  const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
          if (entry.isIntersecting) {
              entry.target.classList.add('visible');
              observer.unobserve(entry.target);
          }
      });
  }, {
      root: null,
      rootMargin: '0px',
      threshold: 0.1
  });

  fadeElements.forEach(el => observer.observe(el));

  // 4. Industry Tabs Switcher
  const tabs = document.querySelectorAll('.industry-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
      tab.addEventListener('click', () => {
          // Remove active states from all tabs
          tabs.forEach(t => {
              t.classList.remove('active', 'border-gray-400');
              t.classList.add('text-gray-300', 'border-gray-600');
          });
          
          // Add active state to clicked tab
          tab.classList.add('active');
          tab.classList.remove('text-gray-300', 'border-gray-600');
          
          // Hide all content
          const targetId = tab.getAttribute('data-target');
          
          tabContents.forEach(content => {
              if (content.id === targetId) {
                  // Show active content
                  content.classList.remove('hidden', 'absolute', 'opacity-0');
                  setTimeout(() => content.style.opacity = '1', 10);
              } else {
                  // Hide others
                  content.classList.add('hidden', 'absolute');
                  content.style.opacity = '0';
              }
          });
      });
  });

  // 5. FAQ Accordion
  const faqButtons = document.querySelectorAll('.faq-btn');
  
  faqButtons.forEach(btn => {
      btn.addEventListener('click', function() {
          const content = this.nextElementSibling;
          const icon = this.querySelector('svg');
          
          // Is currently open?
          if (content.style.maxHeight) {
              content.style.maxHeight = null;
              icon.classList.remove('rotate-180');
              this.classList.remove('bg-gray-100');
          } else {
              // Close all others
              document.querySelectorAll('.accordion-content').forEach(c => c.style.maxHeight = null);
              document.querySelectorAll('.faq-btn svg').forEach(i => i.classList.remove('rotate-180'));
              document.querySelectorAll('.faq-btn').forEach(b => b.classList.remove('bg-gray-100'));
              
              // Open this one
              content.style.maxHeight = content.scrollHeight + "px";
              icon.classList.add('rotate-180');
              this.classList.add('bg-gray-100');
          }
      });
  });

  // 6. Particle Canvas Background (Hero)
  const canvas = document.getElementById('hero-canvas');
  if (canvas) {
      const ctx = canvas.getContext('2d');
      let particles = [];
      let width, height;

      const initParams = () => {
          width = canvas.width = window.innerWidth;
          height = canvas.height = canvas.parentElement.offsetHeight;
      };

      class Particle {
          constructor() {
              this.x = Math.random() * width;
              this.y = Math.random() * height;
              this.vx = (Math.random() - 0.5) * 0.5;
              this.vy = (Math.random() - 0.5) * 0.5;
              this.size = Math.random() * 2 + 0.5;
              this.baseAlpha = Math.random() * 0.5 + 0.1;
          }

          update() {
              this.x += this.vx;
              this.y += this.vy;

              if (this.x < 0 || this.x > width) this.vx *= -1;
              if (this.y < 0 || this.y > height) this.vy *= -1;
          }

          draw() {
              ctx.beginPath();
              ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
              ctx.fillStyle = `rgba(22, 163, 74, ${this.baseAlpha})`;
              ctx.fill();
          }
      }

      const initParticles = () => {
          particles = [];
          const count = window.innerWidth > 768 ? 80 : 30;
          for (let i = 0; i < count; i++) {
              particles.push(new Particle());
          }
      };

      const animate = () => {
          ctx.clearRect(0, 0, width, height);
          
          particles.forEach(p => {
              p.update();
              p.draw();
          });

          // Draw lines between close particles
          for (let i = 0; i < particles.length; i++) {
              for (let j = i + 1; j < particles.length; j++) {
                  const dx = particles[i].x - particles[j].x;
                  const dy = particles[i].y - particles[j].y;
                  const dist = Math.sqrt(dx * dx + dy * dy);

                  if (dist < 120) {
                      ctx.beginPath();
                      ctx.strokeStyle = `rgba(22, 163, 74, ${0.15 - dist/800})`;
                      ctx.lineWidth = 0.5;
                      ctx.moveTo(particles[i].x, particles[i].y);
                      ctx.lineTo(particles[j].x, particles[j].y);
                      ctx.stroke();
                  }
              }
          }

          requestAnimationFrame(animate);
      };

      window.addEventListener('resize', () => {
          initParams();
          initParticles();
      });

      initParams();
      initParticles();
      animate();
  }

  // 7. Mini animation for hero counter card
  const animTx = document.getElementById('anim-tx');
  const animDeduction = document.getElementById('anim-deduction');
  
  if (animTx && animDeduction) {
      setTimeout(() => {
          // simple number iteration effect
          let count = 0;
          const interval = setInterval(() => {
              count += Math.floor(Math.random() * 10) + 1;
              if (count >= 128) {
                  count = 128;
                  clearInterval(interval);
              }
              animTx.innerText = count;
          }, 30);
      }, 1000);
      
      setInterval(() => {
          animDeduction.classList.add('text-white');
          setTimeout(() => animDeduction.classList.remove('text-white'), 300);
      }, 5000);
  }

});
