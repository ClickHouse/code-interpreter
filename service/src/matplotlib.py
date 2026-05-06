import os
import logging
from types import SimpleNamespace
import sys

# Create a namespace for our variables
______ns = SimpleNamespace()

# Set up logging
try:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    ______ns.logger = logging.getLogger(__name__)
except Exception as e:
    print(f"Failed to set up logging: {e}")
    sys.exit(1)

# Set the environment variables BEFORE importing matplotlib
try:
    os.environ['MPLBACKEND'] = 'Agg'
    os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib'  # Required: sandbox has no home dir
except Exception as e:
    ______ns.logger.error(f"Failed to set environment variables: {e}")
    sys.exit(1)

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

______ns.plot_counter = 0
______ns.saved_figures = set()

def ______custom_show():
    """Custom function to replace plt.show()"""
    global ______ns
    current_fig = plt.gcf()
    
    if current_fig.number not in ______ns.saved_figures:
        ______ns.plot_counter += 1
        filename = f"plot_{______ns.plot_counter}.png"
        current_fig.savefig(filename)
        ______ns.logger.info(f"Plot saved as {filename}")
        ______ns.saved_figures.add(current_fig.number)
    else:
        ______ns.logger.info(f"Figure {current_fig.number} has already been saved, skipping save operation")
    
    plt.close(current_fig)

# Override plt.show and plt.savefig
plt.show = ______custom_show

original_savefig = plt.savefig

# Maximum DPI to prevent excessive rendering time
______MAX_DPI = 200

def ______custom_savefig(*args, **kwargs):
    current_fig = plt.gcf()
    ______ns.saved_figures.add(current_fig.number)
    
    # Cap DPI to prevent performance issues
    if 'dpi' in kwargs and kwargs.get('dpi', 0) > ______MAX_DPI:
        ______ns.logger.debug(f"Capping DPI from {kwargs['dpi']} to {______MAX_DPI}")
        kwargs['dpi'] = ______MAX_DPI
    
    return original_savefig(*args, **kwargs)

plt.savefig = ______custom_savefig

def main():

    # BEGIN USER CODE
    # User code will be inserted here
    # END USER CODE

if __name__ == "__main__":
    main()