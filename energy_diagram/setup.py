from setuptools import setup, find_packages

setup(
    name="energydiagram",
    version="1.0",
    packages=find_packages(),
    install_requires=[
        'numpy>=1.18',
        'scipy>=1.4',
        'matplotlib>=3.1'
    ],
) 