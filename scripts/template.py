import os
import dill
import logging
from types import SimpleNamespace, ModuleType
import sys

# Create a namespace for our variables
_ns = SimpleNamespace()

# Set up logging
try:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    _ns.logger = logging.getLogger(__name__)
except Exception as e:
    print(f"Failed to set up logging: {e}")
    sys.exit(1)

# Set the environment variables BEFORE importing matplotlib
try:
    os.environ['MPLBACKEND'] = 'Agg'
    os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'  # Required: sandbox has no home dir
except Exception as e:
    _ns.logger.error(f"Failed to set environment variables: {e}")
    sys.exit(1)

# List of modules to exclude from persistence
_EXCLUDED_MODULES = frozenset({'dill', 'os', 'sys', 'logging', 'SimpleNamespace', 'plt', 'matplotlib'})

# Set backend BEFORE importing pyplot (more reliable than env var)
import matplotlib
matplotlib.use('Agg')

# Optimize matplotlib settings BEFORE importing pyplot
matplotlib.rcParams.update({
    'figure.dpi': 100,              # Reasonable default (user can override)
    'savefig.dpi': 150,             # Cap savefig DPI for performance
    'figure.max_open_warning': 0,   # Disable warning spam
    'axes.formatter.useoffset': False,
    'font.family': 'DejaVu Sans',   # Use a font that's pre-cached
    'text.usetex': False,           # Disable LaTeX (slow)
    'svg.fonttype': 'none',         # Don't embed fonts in SVG
})

import matplotlib.pyplot as plt

_ns.plot_counter = 0

# Maximum DPI to prevent excessive rendering time
_MAX_DPI = 200

_original_savefig = plt.savefig

def _custom_savefig(*args, **kwargs):
    # Cap DPI to prevent performance issues
    if 'dpi' in kwargs and kwargs.get('dpi', 0) > _MAX_DPI:
        _ns.logger.debug(f"Capping DPI from {kwargs['dpi']} to {_MAX_DPI}")
        kwargs['dpi'] = _MAX_DPI
    return _original_savefig(*args, **kwargs)

plt.savefig = _custom_savefig

def custom_show():
    """Custom function to replace plt.show()"""
    global _ns
    _ns.plot_counter += 1
    filename = f"plot_{_ns.plot_counter}.png"
    plt.savefig(filename)
    _ns.logger.info(f"Plot saved as {filename}")
    plt.close()

plt.show = custom_show

def _load_session():
    """Load the previous session if it exists."""
    if os.path.exists('session.dill'):
        try:
            with open('session.dill', 'rb') as f:
                loaded_globals = dill.load(f)
            _ns.logger.info("Previous session loaded successfully.")
            try:
                os.remove('session.dill')
                _ns.logger.info("Previous session file deleted.")
            except OSError as e:
                _ns.logger.warning(f"Failed to delete previous session file: {e}")
            return loaded_globals
        except Exception as e:
            _ns.logger.error(f"Error loading previous session: {e}")
    return {}

def _run_user_code(code):
    """Run user code."""
    try:
        exec(code, globals())
    except Exception as e:
        _ns.logger.error(f"Error executing user code: {e}")

def _is_module(obj):
    """Check if an object is a module."""
    return isinstance(obj, ModuleType)

def _is_safe_to_persist(key, value):
    """Check if an object is safe to persist."""
    return (not key.startswith('_') and
            key not in _EXCLUDED_MODULES and
            not _is_module(value) and
            not callable(value))

def _save_session():
    """Save the current session."""
    try:
        user_globals = {k: v for k, v in globals().items() if _is_safe_to_persist(k, v)}
        temp_file = 'session_temp.dill'
        with open(temp_file, 'wb') as f:
            dill.dump(user_globals, f)
        os.replace(temp_file, 'session.dill')
        _ns.logger.info("Session data saved successfully.")
    except Exception as e:
        _ns.logger.error(f"Error saving session data: {e}")

def main():
    try:
        # Load previous session
        globals().update(_load_session())
    except Exception as e:
        _ns.logger.critical(f"Unexpected error in main execution: {e}")
        sys.exit(1)

    # BEGIN USER CODE
    # User code will be inserted here
    # END USER CODE

    # Save the session
    try:
        _save_session()

        # Print what was saved (excluding built-ins and modules)
        _ns.logger.info("\nObjects saved in session:")
        for key, value in globals().items():
            if _is_safe_to_persist(key, value):
                _ns.logger.info(f"{key}: {type(value)}")
    except Exception as e:
        _ns.logger.critical(f"Unexpected error in main execution: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()