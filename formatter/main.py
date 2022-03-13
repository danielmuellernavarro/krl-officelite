import re
import sys
from krl import Formatter


def main():
    sys.stdout.reconfigure(encoding='utf-8') 
    options = dict(filename='-', startLine=1, endLine=None, indentWidth=4, separateBlocks=True)
    if len(sys.argv) < 2:
        usage = 'usage: formatter.py filename [options...]\n'
        opt = '  OPTIONS:\n'
        for key in options:
            val = options[key]
            key_type = re.match(r'\<class \'(.*)\'\>', str(type(val))).group(1)
            key_type = key_type.replace('NoneType', 'int')
            opt += '    --%s=%s\n' % (key, key_type)

        print('%s%s' % (usage, opt), file=sys.stderr)

    else:
        for arg in sys.argv[1:]:
            key, value = arg.split('=')
            if key == '--filename':
                pass
            elif any(char.isdigit() for char in value):
                value = int(value)
            elif value.lower() == 'true':
                value = True
            elif value.lower() == 'false':
                value = False
            options[key.strip()] = value

        filename = options['--filename']
        indentWidth = options['--indentWidth']
        startLine = options['--startLine']
        endLine = options['--endLine']
        separateBlocks = options['--separateBlocks']

        formatter = Formatter(indentWidth=indentWidth, separateBlocks=separateBlocks)
        formatter.formatFile(filename, startLine, endLine)


if __name__ == '__main__':
    main()