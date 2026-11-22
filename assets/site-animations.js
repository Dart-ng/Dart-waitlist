(() => {
  const reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canObserve = !reducedMotion && 'IntersectionObserver' in window;
  const activeAnimations = new WeakMap();

  function formatCount(value, options) {
    const formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: options.decimals,
      maximumFractionDigits: options.decimals,
      minimumIntegerDigits: options.minimumIntegerDigits,
    });
    return `${options.prefix}${formatter.format(value)}${options.suffix}`;
  }

  function countTo(element, target, overrides) {
    const value = Number(target);
    if (!element || !Number.isFinite(value)) return;

    const settings = Object.assign({
      prefix: '',
      suffix: '',
      decimals: 0,
      minimumIntegerDigits: 1,
      startValue: 0,
      duration: 1050,
    }, overrides || {});
    const priorFrame = activeAnimations.get(element);
    if (priorFrame) cancelAnimationFrame(priorFrame);

    const initialValue = Number.isFinite(Number(settings.startValue)) ? Number(settings.startValue) : 0;
    const difference = value - initialValue;
    const precision = Math.pow(10, settings.decimals);
    const finish = () => {
      element.textContent = formatCount(value, settings);
      activeAnimations.delete(element);
    };
    if (reducedMotion || settings.duration <= 0) {
      finish();
      return;
    }

    const startTime = performance.now();
    const frame = (timestamp) => {
      const progress = Math.min((timestamp - startTime) / settings.duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round((initialValue + difference * eased) * precision) / precision;
      element.textContent = formatCount(current, settings);
      if (progress < 1) {
        activeAnimations.set(element, requestAnimationFrame(frame));
      } else {
        finish();
      }
    };

    element.textContent = formatCount(initialValue, settings);
    activeAnimations.set(element, requestAnimationFrame(frame));
  }

  window.DartAnimations = { countTo };

  const counters = Array.from(document.querySelectorAll('[data-count-target]'));
  const animateStaticCounter = (element) => {
    countTo(element, element.dataset.countTarget, {
      prefix: element.dataset.countPrefix || '',
      suffix: element.dataset.countSuffix || '',
      decimals: Number(element.dataset.countDecimals || 0),
      minimumIntegerDigits: Number(element.dataset.countMinInteger || 1),
      duration: Number(element.dataset.countDuration || 1050),
    });
  };

  if (canObserve) {
    document.documentElement.classList.add('dart-motion-ready');
    const revealObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });

    const revealTargets = new Set(document.querySelectorAll('main > section'));
    document.querySelectorAll('main section .grid').forEach((grid) => {
      Array.from(grid.children).forEach((card, index) => {
        revealTargets.add(card);
        card.classList.add('dart-card-lift');
        card.style.setProperty('--dart-reveal-delay', `${Math.min(index, 4) * 80}ms`);
      });
    });
    revealTargets.forEach((element) => {
      element.dataset.dartReveal = '';
      revealObserver.observe(element);
    });

    const counterObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animateStaticCounter(entry.target);
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.4 });
    counters.forEach((counter) => counterObserver.observe(counter));
  } else {
    counters.forEach(animateStaticCounter);
  }
})();
