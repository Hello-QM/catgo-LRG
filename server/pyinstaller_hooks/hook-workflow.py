# Override broken hook-workflow.py from pyinstaller-hooks-contrib.
# Our server/workflow/ package is NOT the third-party 'workflow' pip package.
# This empty hook prevents the contrib hook from crashing.
