# This script is a prototype of a wrapper script to ensure libraries work as expected
# The script runs in a protected sandbox environment and saves the user-defined globals to a file for later sessions

import os

# Set the environment variable
os.environ['MPLBACKEND'] = 'Agg'
os.environ['MPLCONFIGDIR'] = '/tmp/matplotlib-config'

import dill
import types

# The user submitted code
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 2*np.pi, 100)
y = np.sin(x)
plt.plot(x, y)
plt.savefig("./sine_wave.png")
print("Plot saved as sine_wave.png")

# Function to get user-defined globals
def get_user_defined_globals():
    return {
        key: value for key, value in globals().items()
        if not key.startswith('__') and
        not isinstance(value, types.ModuleType) and
        key not in ('np', 'dill', 'types', 'get_user_defined_globals')
    }

# Save user-defined globals to a file
with open('session.dill', 'wb') as f:
    dill.dump(get_user_defined_globals(), f)

print("\nSession data saved to 'session.dill'")

# Print what was saved
print("\nObjects saved in session:")
for key, value in get_user_defined_globals().items():
    print(f"{key}: {type(value)}")
