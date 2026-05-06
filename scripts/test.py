import numpy as np
import dill
import types

# Your original code
arr = np.array([1, 2, 3, 4, 5])
print(f'Array: {arr}')
print(f'Mean: {np.mean(arr)}')
print(f'Sum: {np.sum(arr)}')
print(f'Standard Deviation: {np.std(arr)}')

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
