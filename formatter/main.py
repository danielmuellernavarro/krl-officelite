import re
import sys
import defaultKwargs
from krl import Formatter


def main():
    sys.stdout.reconfigure(encoding='utf-8') 
    kwargs = defaultKwargs.kwargs
    if len(sys.argv) < 2:
        usage = 'usage: formatter.py filename [options...]\n'
        opt = '  OPTIONS:\n'
        for key in kwargs:
            val = kwargs[key]
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
            elif value.lower() == 'false':
                value = False
            elif value.lower() == 'true':
                value = True
            kwargs[key.strip()] = value

        formatter = Formatter(**kwargs)
        formatter.formatFile()


if __name__ == '__main__':
    main()